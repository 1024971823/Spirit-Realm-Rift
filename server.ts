import express from 'express';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { createGamePool, measureTicks, type GameWorker, type TickStats } from './backend/gamePool.ts';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { makeServices, type Auth, type Result } from './backend/services.ts';
import { computePlayerShot, playerMotionFromSnapshot, readPlayerAim, readPlayerInput, stepPlayerMotion, type PlayerInput } from './src/shared/playerInput.ts';
import {
  AMMO_PACKS,
  canPurchaseAmmoPack,
  canRobotClassFire,
  COSMETICS,
  DEFAULT_CONTROLLER,
  DEFAULT_LOADOUT,
  GADGETS,
  getInitialAmmoForClass,
  INITIAL_TEAM_CREDITS,
  MAPS,
  normalizeControllerConfig,
  ROBOT_CLASSES,
  sanitizeLoadoutForXp,
  WEAPONS,
} from './src/shared/catalog.ts';
import {
  validateFireCadence,
  validateGadgetCooldown,
  validateShotLineOfSight,
} from './src/shared/anticheat.ts';
import {
  evaluateMatchOutcome,
} from './src/shared/matchmaking.ts';
import {
  computeObstacleAvoidanceDir,
  evaluateHazardState,
  extractOreFromNode,
  getArenaActiveColliders,
  isPlayerHitByHazard,
  ORE_MINE_RADIUS,
  rayIntersectAabb,
  rayIntersectRobot,
  resolvePlayerMovement,
  rotateTowardsAngle,
} from './src/shared/physics.ts';
import type {
  AmmoPackId,
  AntiCheatAudit,
  BeamVisualEvent,
  CombatantSnapshot,
  DestructibleBarrierState,
  GameModeId,
  HazardRuntimeState,
  KillFeedEvent,
  LobbyConfig,
  MapId,
  MatchSnapshot,
  OreNodeState,
  PlatformType,
  PlayerProfile,
  RobotClass,
  TeamId,
  Vec3,
  WeaponId,
} from './src/shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const OWNER_ID = randomUUID();
const SIM_WORKER = process.env.PRISM_SIM_WORKER;
const MATCH_MS = 180_000;
const SEAT_MS = 60_000;
const READY_MS = 15_000;
const ROOM_SIZE = 6;
const PRIVATE_ROOM_MIN_PLAYERS = process.env.PUBLIC_ACCESS !== '1' && process.env.ALLOW_SOLO_PLAYTEST === '1' ? 1 : 2;
const TICK_MS = 50;
const MAX_SEND_BUFFER = 512 * 1024;
const ONLINE_LIMIT = Math.floor(clampNum(process.env.ONLINE_LIMIT ?? (process.env.PUBLIC_ACCESS === '1' ? 100 : 1000), 6, 2000, 100));
let workerFailures = 0;
let settlementFailures = 0;
let revocationEpoch = 0;
const revocations = new Map<string, number>();
let services: Awaited<ReturnType<typeof makeServices>>;
let closing = false;

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// =============================================================================
// Authoritative Multiplayer Room Simulation
// =============================================================================

interface ServerCombatant extends CombatantSnapshot {
  lastShotAtMs: number;
  lastGadgetAtMs: number;
  lastClassSkillAtMs: number;
  classSkillReadyAtMs?: number;
  gadgetReadyAtMs?: number;
  input?: PlayerInput;
  inputAtMs?: number;
  dashPending?: boolean;
  lastReceivedInputSeq?: number;
  lastActionSeq?: number;
  ads?: boolean;
  ventAtMs?: number;
  phaseDashPending?: boolean;
  gadgetId?: PlayerProfile['loadout']['gadgetId'];
  lastMineAtMs: number;
  shotsFiredMatch: number;
  shotsHitMatch: number;
  hazardKillsMatch: number;
  barriersDestroyedMatch: number;
  shieldActiveUntil: number;
  overclockUntil: number;
  oreFracBuffer: number;
  stashedCombatAmmo?: number;
  lastHazardHitAtMs: number;
  lastHazardId?: string;
  botTargetYaw: number;
  botDecisionAtMs: number;
  botStrafeDir: number;
  botLastX: number;
  botLastZ: number;
  botStuckTicks: number;
}

interface ServerRoom {
  config: LobbyConfig;
  phase: 'waiting' | 'active' | 'ended';
  publicMatch: boolean;
  fillBots: boolean;
  members: Map<string, Member>;
  matchId: string | null;
  serverTick: number;
  starting: boolean;
  terminating?: boolean;
  startedAtMs: number;
  durationSec: number;
  scoreLimit: number;
  scoreCobalt: number;
  scoreAmber: number;
  teamCreditsCobalt: number;
  teamCreditsAmber: number;
  controlOwner: TeamId | 'contested' | 'neutral';
  controlProgress: number;
  players: Map<string, ServerCombatant>;
  barriers: Map<string, DestructibleBarrierState>;
  oreNodes: Map<string, OreNodeState>;
  hazards: HazardRuntimeState[];
  killFeed: KillFeedEvent[];
  antiCheat: AntiCheatAudit;
  matchFinalized: boolean;

}

type Adjudication = TeamId | 'cancelled';
type GameCommand =
  | { type: 'start'; room: ServerRoom }
  | { type: 'input'; matchId: string; playerId: string; action: string; payload: Record<string, unknown> }
  | { type: 'profile'; matchId: string; playerId: string; profile: PlayerProfile }
  | { type: 'seat'; matchId: string; playerId: string; status: 'joined' | 'disconnected' | 'forfeited' }
  | { type: 'finish'; matchId: string; adjudication: Adjudication };
type GameEvent =
  | { type: 'ready' }
  | { type: 'metrics'; stats: TickStats }
  | { type: 'broadcast'; matchId: string; snapshot: boolean; wire: string }
  | { type: 'direct'; matchId: string; playerId: string; wire: string }
  | { type: 'finish'; matchId: string; room: ServerRoom; adjudication?: Adjudication };
const matches = new Map<string, { room: ServerRoom; worker: GameWorker; snapshotWire?: string }>();
let gamePool: ReturnType<typeof createGamePool<GameCommand, GameEvent>>;

interface Member {
  id: string;
  profile: PlayerProfile;
  team: TeamId;
  joinedAt: number;
  detachedAt?: number;
  forfeited?: boolean;
}
interface Connection {
  ws: WebSocket;
  auth: Auth;
  req: http.IncomingMessage;
  profile: PlayerProfile;
  windowAt: number;
  packets: number;
  commands: number;
  eligibilityCheck: boolean;
  pendingCommands: number;
  commandChain: Promise<void>;
  alive: boolean;
  playUntil: number;
}
interface QueueEntry { id: string; queuedAt: number; order: number; profile: PlayerProfile }
interface ReadyCheck { id: string; entries: QueueEntry[]; accepted: Set<string>; deadline: number; starting: boolean }
const connections = new Map<string, Connection>();
const rooms = new Map<string, ServerRoom>();
const roomByPlayer = new Map<string, ServerRoom>();
const queue = new Map<string, QueueEntry>();
const pendingReady = new Map<string, ReadyCheck>();
const readyByPlayer = new Map<string, ReadyCheck>();
let queueOrder = 0;
let nextPublicMap = 0;

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code: string;
  do {
    code = 'PRISM-';
    for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(options: Partial<LobbyConfig> & { publicMatch?: boolean; fillBots?: boolean }): ServerRoom {
  const roomId = generateRoomCode();
  const mapId: MapId = options.mapId && Object.hasOwn(MAPS, options.mapId) ? options.mapId : 'reactor_foundry';
  const map = MAPS[mapId];

  const barriers = new Map<string, DestructibleBarrierState>();
  for (const b of map.barriers) {
    barriers.set(b.id, {
      id: b.id,
      hp: b.maxHp,
      maxHp: b.maxHp,
      destroyed: false,
      respawnAt: 0,
    });
  }

  const oreNodes = new Map<string, OreNodeState>();
  for (const o of map.oreNodes) {
    oreNodes.set(o.id, {
      id: o.id,
      x: o.x,
      y: o.y,
      z: o.z,
      amount: o.maxAmount,
      maxAmount: o.maxAmount,
      tier: o.tier,
      depleted: false,
      respawnAt: 0,
    });
  }

  const mode: GameModeId =
    options.mode === 'ffa' || options.mode === 'control_core' || options.mode === 'team_clash'
      ? options.mode
      : 'team_clash';
  const now = Date.now();

  const room: ServerRoom = {
    config: {
      roomId,
      name: String(options.name || `Arena ${roomId}`).slice(0, 40),
      hostId: options.hostId || 'system',
      hostCallsign: options.hostCallsign || 'Arena Control',
      isPrivate: Boolean(options.isPrivate),
      mapId,
      mode,
      maxPlayers: ROOM_SIZE,
      hazardIntensity: options.hazardIntensity === 'overdrive' ? 'overdrive' : 'standard',
      friendlyFire: Boolean(options.friendlyFire),
      crossplayPool: true,
      playerCount: 0,
      avgMmr: 1250,
    },
    phase: 'waiting',
    publicMatch: options.publicMatch === true,
    fillBots: options.fillBots === true,
    members: new Map(),
    matchId: null,
    serverTick: 0,
    starting: false,
    startedAtMs: now,
    durationSec: MATCH_MS / 1000,
    scoreLimit: mode === 'ffa' ? 15 : 25,
    scoreCobalt: 0,
    scoreAmber: 0,
    teamCreditsCobalt: INITIAL_TEAM_CREDITS,
    teamCreditsAmber: INITIAL_TEAM_CREDITS,
    controlOwner: 'neutral',
    controlProgress: 0,
    players: new Map(),
    barriers,
    oreNodes,
    hazards: map.hazards.map((h) => evaluateHazardState(h, 0, options.hazardIntensity === 'overdrive')),
    killFeed: [],
    antiCheat: {
      packetsValidated: 0,
      movementCorrections: 0,
      rateLimitBlocks: 0,
      losRejections: 0,
      integrityStatus: 'verified',
      lastCheckAt: now,
    },
    matchFinalized: false,
  };

  rooms.set(roomId, room);
  return room;
}

function pickSpawnForTeam(mapId: MapId, team: TeamId, mode: GameModeId): { x: number; y: number; z: number; yaw: number } {
  const map = MAPS[mapId];
  const candidates =
    mode === 'ffa'
      ? map.spawns
      : map.spawns.filter((s) => s.team === team);
  const pool = candidates.length > 0 ? candidates : map.spawns;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return {
    x: pick.x + (Math.random() - 0.5) * 1.6,
    y: pick.y,
    z: pick.z + (Math.random() - 0.5) * 1.6,
    yaw: pick.yaw,
  };
}

const BOT_ROSTER: Array<{
  callsign: string;
  policy: 'charger' | 'kiter' | 'orbiter' | 'miner';
  robotClass: RobotClass;
  weaponId: WeaponId;
  platform: PlatformType;
}> = [
  { callsign: '[EP] ForgeMiner-01', policy: 'miner', robotClass: 'ep_miner', weaponId: 'pulse_carbine', platform: 'pc' },
  { callsign: '[EP] TitanMiner-02', policy: 'miner', robotClass: 'ep_miner', weaponId: 'pulse_carbine', platform: 'console' },
  { callsign: '[S1] Striker-03', policy: 'charger', robotClass: 's1_striker', weaponId: 'scatter_projector', platform: 'pc' },
  { callsign: '[S1] PrismEye-04', policy: 'kiter', robotClass: 's1_striker', weaponId: 'prism_railgun', platform: 'console' },
  { callsign: '[S1] Vector-05', policy: 'orbiter', robotClass: 's1_striker', weaponId: 'pulse_carbine', platform: 'cloud' },
  { callsign: '[S1] Helios-06', policy: 'charger', robotClass: 's1_striker', weaponId: 'pulse_carbine', platform: 'pc' },
];

function getTeamCredits(room: ServerRoom, team: TeamId): number {
  return team === 'cobalt' ? room.teamCreditsCobalt : room.teamCreditsAmber;
}

function addTeamCredits(room: ServerRoom, team: TeamId, delta: number): void {
  if (team === 'cobalt') {
    room.teamCreditsCobalt = Math.max(0, Math.round(room.teamCreditsCobalt + delta));
  } else {
    room.teamCreditsAmber = Math.max(0, Math.round(room.teamCreditsAmber + delta));
  }
}

function ensureRoomBots(room: ServerRoom): void {
  const targetCombatants = ROOM_SIZE;
  const humans = Array.from(room.players.values()).filter((p) => !p.isBot);
  const bots = Array.from(room.players.values()).filter((p) => p.isBot);

  while (humans.length + bots.length > targetCombatants && bots.length > 0) {
    const removed = bots.pop()!;
    room.players.delete(removed.id);
  }

  let idx = 0;
  while (room.players.size < targetCombatants && idx < BOT_ROSTER.length) {
    const botId = `bot_${room.config.roomId}_${idx}`;
    if (!room.players.has(botId)) {
      const spec = BOT_ROSTER[idx];
      const cobaltCount = Array.from(room.players.values()).filter((p) => p.team === 'cobalt').length;
      const amberCount = Array.from(room.players.values()).filter((p) => p.team === 'amber').length;
      const team: TeamId = cobaltCount <= amberCount ? 'cobalt' : 'amber';
      const spawn = pickSpawnForTeam(room.config.mapId, team, room.config.mode);
      const classSpec = ROBOT_CLASSES[spec.robotClass];
      const mag = getInitialAmmoForClass(spec.robotClass, spec.weaponId);

      room.players.set(botId, {
        id: botId,
        callsign: spec.callsign,
        isBot: true,
        botPolicy: spec.policy,
        robotClass: spec.robotClass,
        team,
        platform: spec.platform,
        x: spawn.x,
        y: spawn.y,
        z: spawn.z,
        yaw: spawn.yaw,
        chassisYaw: spawn.yaw,
        pitch: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        hp: classSpec.maxHp,
        maxHp: classSpec.maxHp,
        shield: classSpec.maxShield,
        maxShield: classSpec.maxShield,
        ammo: mag,
        maxAmmo: mag,
        alive: true,
        respawnAt: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        damageDealt: 0,
        oreMined: 0,
        weaponId: spec.weaponId,
        beamHex: team === 'cobalt' ? '#06B6D4' : '#F59E0B',
        skinHex: spec.robotClass === 'ep_miner'
          ? (team === 'cobalt' ? '#0F766E' : '#92400E')
          : (team === 'cobalt' ? '#0E7490' : '#B45309'),
        dashing: false,
        shieldActive: false,
        overclocked: false,
        miningNodeId: null,
        slowedUntil: 0,
        speaking: false,
        lastShotAtMs: 0,
        lastGadgetAtMs: 0,
        lastClassSkillAtMs: 0,
        lastMineAtMs: 0,
        shotsFiredMatch: 0,
        shotsHitMatch: 0,
        hazardKillsMatch: 0,
        barriersDestroyedMatch: 0,
        shieldActiveUntil: 0,
        overclockUntil: 0,
        oreFracBuffer: 0,
        lastHazardHitAtMs: 0,
        botTargetYaw: spawn.yaw,
        botDecisionAtMs: 0,
        botStrafeDir: idx % 2 === 0 ? 1 : -1,
        botLastX: spawn.x,
        botLastZ: spawn.z,
        botStuckTicks: 0,
      });
    }
    idx++;
  }

}

function serializeRoomSnapshot(room: ServerRoom): MatchSnapshot {
  const now = Date.now();
  const elapsedSec = Math.min(room.durationSec, (now - room.startedAtMs) / 1000);
  const players: CombatantSnapshot[] = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    callsign: p.callsign,
    isBot: p.isBot,
    botPolicy: p.botPolicy,
    robotClass: p.robotClass,
    team: p.team,
    platform: p.platform,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    chassisYaw: p.chassisYaw,
    pitch: p.pitch,
    vx: p.vx,
    vy: p.vy,
    vz: p.vz,
    hp: Math.round(p.hp),
    maxHp: p.maxHp,
    shield: Math.round(p.shield),
    maxShield: p.maxShield,
    ammo: Math.max(0, Math.round(p.ammo)),
    maxAmmo: p.maxAmmo,
    alive: p.alive,
    respawnAt: p.respawnAt,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    damageDealt: Math.round(p.damageDealt),
    oreMined: Math.round(p.oreMined),
    weaponId: p.weaponId,
    beamHex: p.beamHex,
    skinHex: p.skinHex,
    dashing: p.dashing,
    shieldActive: p.shieldActiveUntil > now,
    overclocked: p.overclockUntil > now,
    miningNodeId: p.miningNodeId,
    slowedUntil: p.slowedUntil,
    speaking: p.speaking,
    ...(p.isBot ? {} : {
      lastProcessedInputSeq: p.lastProcessedInputSeq ?? 0,
      grounded: p.grounded ?? true,
      dashCooldown: p.dashCooldown ?? 0,
      dashRemaining: p.dashRemaining ?? 0,
      heat: p.heat ?? 0,
      overheated: p.overheated ?? false,
      gadgetCooldown: Math.max(0, ((p.gadgetReadyAtMs ?? 0) - now) / 1000),
      classSkillCooldown: Math.max(0, ((p.classSkillReadyAtMs ?? 0) - now) / 1000),
    }),
  }));

  return {
    roomId: room.config.roomId,
    matchId: room.matchId ?? undefined,
    serverTick: room.serverTick,
    serverTimeMs: now,
    isPrivate: room.config.isPrivate,
    mapId: room.config.mapId,
    mode: room.config.mode,
    phase: room.phase === 'waiting' ? 'ended' : room.phase,
    elapsedSec,
    durationSec: room.durationSec,
    scoreCobalt: Math.round(room.scoreCobalt),
    scoreAmber: Math.round(room.scoreAmber),
    scoreLimit: room.scoreLimit,
    teamCreditsCobalt: Math.round(room.teamCreditsCobalt),
    teamCreditsAmber: Math.round(room.teamCreditsAmber),
    controlOwner: room.controlOwner,
    controlProgress: room.controlProgress,
    players,
    barriers: Array.from(room.barriers.values()),
    hazards: room.hazards,
    oreNodes: Array.from(room.oreNodes.values()),
    killFeed: room.killFeed.slice(-8),
    antiCheat: room.antiCheat,
  };
}

function send(conn: Connection | undefined, type: string, payload: unknown): void {
  if (conn && connections.get(conn.auth.playerId) === conn && conn.ws.readyState === WebSocket.OPEN && conn.ws.bufferedAmount <= MAX_SEND_BUFFER) {
    conn.ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastToRoom(room: ServerRoom, type: string, payload: unknown): void {
  if (SIM_WORKER) {
    const snapshot = type === 'match:state';
    if (room.matchId && (!snapshot || !snapshotBackpressure)) {
      emitGame({ type: 'broadcast', matchId: room.matchId, snapshot, wire: JSON.stringify({ type, payload }) });
    }
    return;
  }
  broadcastWire(room, JSON.stringify({ type, payload }));
}

function broadcastWire(room: ServerRoom, msg: string): void {
  for (const member of room.members.values()) {
    const conn = connections.get(member.id);
    if (!conn || member.detachedAt !== undefined || member.forfeited || conn.ws.readyState !== WebSocket.OPEN) continue;
    if (conn.ws.bufferedAmount > MAX_SEND_BUFFER) continue;
    conn.ws.send(msg);
  }
}

function applyDamage(
  room: ServerRoom,
  victim: ServerCombatant,
  rawDamage: number,
  attacker: ServerCombatant | null,
  weaponOrHazardLabel: string,
  isHazard: boolean,
): void {
  if (!victim.alive || room.phase !== 'active') return;
  const now = Date.now();
  const mult = victim.shieldActiveUntil > now ? 0.45 : 1.0;
  let dmg = rawDamage * mult;

  if (victim.shield > 0) {
    const absorbed = Math.min(victim.shield, dmg);
    victim.shield -= absorbed;
    dmg -= absorbed;
  }
  if (dmg > 0) {
    victim.hp = Math.max(0, victim.hp - dmg);
  }

  if (attacker && attacker.id !== victim.id) {
    attacker.damageDealt += rawDamage * mult;
  }

  if (victim.hp <= 0) {
    victim.alive = false;
    victim.deaths += 1;
    victim.respawnAt = now + 3500;

    if (attacker && attacker.id !== victim.id) {
      attacker.kills += 1;
      if (isHazard) attacker.hazardKillsMatch += 1;
      if (room.config.mode === 'ffa') {
        let topKills = 0;
        for (const c of room.players.values()) {
          if (c.kills > topKills) topKills = c.kills;
        }
        room.scoreCobalt = topKills;
      } else if (room.config.mode !== 'control_core') {
        if (attacker.team === 'cobalt') room.scoreCobalt += 1;
        else room.scoreAmber += 1;
      }
    } else if (isHazard && room.config.mode !== 'ffa' && room.config.mode !== 'control_core') {
      // Environmental hazard score goes to opposing team in team clash
      if (victim.team === 'cobalt') room.scoreAmber += 1;
      else room.scoreCobalt += 1;
    }

    const event: KillFeedEvent = {
      id: `kf_${now}_${Math.random().toString(36).slice(2, 6)}`,
      attackerId: attacker ? attacker.id : null,
      attackerName: attacker ? attacker.callsign : weaponOrHazardLabel,
      attackerTeam: attacker ? attacker.team : 'hazard',
      victimId: victim.id,
      victimName: victim.callsign,
      victimTeam: victim.team,
      weaponOrHazard: weaponOrHazardLabel,
      isHazard,
      timestamp: now,
    };
    room.killFeed.push(event);
    if (room.killFeed.length > 20) room.killFeed.shift();

    if (room.config.mode === 'ffa') {
      if (attacker && attacker.kills >= room.scoreLimit) {
        endSimulation(room);
      }
    } else if (room.scoreCobalt >= room.scoreLimit || room.scoreAmber >= room.scoreLimit) {
      endSimulation(room);
    }
  }
}

function stepBotAi(room: ServerRoom, bot: ServerCombatant, dt: number, now: number): void {
  if (!bot.alive || room.phase !== 'active') return;
  const map = MAPS[room.config.mapId];
  const colliders = getArenaActiveColliders(map, Array.from(room.barriers.values()));
  const classSpec = ROBOT_CLASSES[bot.robotClass];
  const otherRobots: Vec3[] = [];
  for (const other of room.players.values()) {
    if (!other.alive || other.id === bot.id) continue;
    otherRobots.push({ x: other.x, y: other.y, z: other.z });
  }

  // Reset transient mining flag each tick
  bot.miningNodeId = null;

  // S1 Combat Bots spend team credits to resupply ammo when low!
  if (bot.robotClass === 's1_striker' && bot.ammo <= 2) {
    const credits = getTeamCredits(room, bot.team);
    if (credits >= AMMO_PACKS.full_mag.cost) {
      addTeamCredits(room, bot.team, -AMMO_PACKS.full_mag.cost);
      bot.ammo = bot.maxAmmo;
    } else if (credits >= AMMO_PACKS.light_mag.cost) {
      addTeamCredits(room, bot.team, -AMMO_PACKS.light_mag.cost);
      bot.ammo = Math.min(bot.maxAmmo, bot.ammo + AMMO_PACKS.light_mag.ammoGrant);
    }
  }

  // Find closest live enemy
  let target: ServerCombatant | null = null;
  let bestEnemyDist = Infinity;
  for (const other of room.players.values()) {
    if (!other.alive || other.id === bot.id) continue;
    if (room.config.mode !== 'ffa' && other.team === bot.team) continue;
    const d = Math.hypot(other.x - bot.x, other.z - bot.z);
    if (d < bestEnemyDist) {
      bestEnemyDist = d;
      target = other;
    }
  }

  const slowed = bot.slowedUntil > now ? 0.58 : 1.0;
  const baseSpeed = 5.3 * classSpec.speedMult * slowed;
  let wishX = 0;
  let wishZ = 0;
  let desiredAimYaw = bot.yaw;
  let desiredPitch = 0;

  if (bot.robotClass === 'ep_miner') {
    // RoboMaster EP Engineer AI: Prioritize richest active Ore Vein!
    let bestOre: OreNodeState | null = null;
    let bestOreScore = -Infinity;
    for (const ore of room.oreNodes.values()) {
      if (ore.depleted || ore.amount <= 0) continue;
      const d = Math.hypot(ore.x - bot.x, ore.z - bot.z);
      const score = (ore.tier === 'rich' ? 22 : 10) - d;
      if (score > bestOreScore) {
        bestOreScore = score;
        bestOre = ore;
      }
    }

    if (bestOre) {
      const dx = bestOre.x - bot.x;
      const dz = bestOre.z - bot.z;
      const dist = Math.hypot(dx, dz);
      desiredAimYaw = Math.atan2(-dx, -dz);

      if (dist > ORE_MINE_RADIUS * 0.68) {
        wishX = (dx / Math.max(0.01, dist)) * baseSpeed;
        wishZ = (dz / Math.max(0.01, dist)) * baseSpeed;
      } else {
        // Hold steady position & mine crystal!
        bot.miningNodeId = bestOre.id;
        // Periodically pop Turbo Extraction skill while mining
        if (now - bot.lastClassSkillAtMs > classSpec.classSkillCooldownSec * 1000) {
          bot.lastClassSkillAtMs = now;
          bot.overclockUntil = now + 4500;
        }
        const rate = classSpec.miningRatePerSec * (bot.overclockUntil > now ? 1.85 : 1.0);
        const { extracted } = extractOreFromNode(bestOre, rate, dt, now);
        if (extracted > 0) {
          bot.oreFracBuffer += extracted;
          if (bot.oreFracBuffer >= 1) {
            const whole = Math.floor(bot.oreFracBuffer);
            bot.oreFracBuffer -= whole;
            bot.oreMined += whole;
            addTeamCredits(room, bot.team, whole);
          }
        }
      }
    } else if (target) {
      // Fallback evasive orbit if all ore nodes temporarily depleted (unarmed engineer)
      const dx = target.x - bot.x;
      const dz = target.z - bot.z;
      desiredAimYaw = Math.atan2(-dx, -dz);
      const dirX = dx / Math.max(0.01, bestEnemyDist);
      const dirZ = dz / Math.max(0.01, bestEnemyDist);
      wishX = -dirZ * bot.botStrafeDir * baseSpeed * 0.7;
      wishZ = dirX * bot.botStrafeDir * baseSpeed * 0.7;
    }
  } else if (target) {
    // RoboMaster S1 Combat Bot AI
    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    desiredAimYaw = Math.atan2(-dx, -dz);
    desiredPitch = Math.atan2((target.y + 0.7) - (bot.y + 1.0), Math.max(0.5, bestEnemyDist));

    const dirX = dx / Math.max(0.01, bestEnemyDist);
    const dirZ = dz / Math.max(0.01, bestEnemyDist);
    const perpX = -dirZ * bot.botStrafeDir;
    const perpZ = dirX * bot.botStrafeDir;

    if (now - bot.botDecisionAtMs > 2200) {
      bot.botDecisionAtMs = now;
      if (Math.random() < 0.35) bot.botStrafeDir *= -1;
    }

    if (bot.ammo <= 0) {
      // Conserve / escort central area until team economy buys ammo
      wishX = perpX * baseSpeed * 0.65;
      wishZ = perpZ * baseSpeed * 0.65;
    } else if (bot.botPolicy === 'charger') {
      if (bestEnemyDist > 8.5) {
        wishX = (dirX + perpX * 0.25) * baseSpeed;
        wishZ = (dirZ + perpZ * 0.25) * baseSpeed;
      } else {
        wishX = perpX * baseSpeed * 0.85;
        wishZ = perpZ * baseSpeed * 0.85;
      }
    } else if (bot.botPolicy === 'kiter') {
      if (bestEnemyDist < 16) {
        wishX = (-dirX * 0.85 + perpX * 0.45) * baseSpeed;
        wishZ = (-dirZ * 0.85 + perpZ * 0.45) * baseSpeed;
      } else if (bestEnemyDist > 28) {
        wishX = dirX * baseSpeed * 0.72;
        wishZ = dirZ * baseSpeed * 0.72;
      } else {
        wishX = perpX * baseSpeed * 0.55;
        wishZ = perpZ * baseSpeed * 0.55;
      }
    } else {
      wishX = perpX * baseSpeed * 0.88 + (bestEnemyDist > 18 ? dirX * baseSpeed * 0.35 : 0);
      wishZ = perpZ * baseSpeed * 0.88 + (bestEnemyDist > 18 ? dirZ * baseSpeed * 0.35 : 0);
    }

    // Attempt fire if ammo > 0 & LOS clear
    const weapon = WEAPONS[bot.weaponId];
    const botFireInterval = Math.max(weapon.fireIntervalMs * 2.4, 540);
    if (bot.ammo > 0 && bestEnemyDist < weapon.range * 0.85 && now - bot.lastShotAtMs >= botFireInterval) {
      const origin: Vec3 = { x: bot.x, y: bot.y + 1.0, z: bot.z };
      const aimY = target.y + 0.72 - origin.y;
      const len = Math.hypot(dx, aimY, dz) || 1;
      const aimDir: Vec3 = { x: dx / len, y: aimY / len, z: dz / len };
      const los = validateShotLineOfSight(origin, aimDir, bestEnemyDist, colliders, weapon.range);
      if (los.clear) {
        bot.lastShotAtMs = now;
        bot.ammo = Math.max(0, bot.ammo - 1);
        const hitChance = bestEnemyDist < 20 ? 0.5 : 0.32;
        const endPos: Vec3 = {
          x: origin.x + aimDir.x * bestEnemyDist + (Math.random() - 0.5) * 0.6,
          y: origin.y + aimDir.y * bestEnemyDist + (Math.random() - 0.5) * 0.4,
          z: origin.z + aimDir.z * bestEnemyDist + (Math.random() - 0.5) * 0.6,
        };
        broadcastToRoom(room, 'match:beam', {
          id: `b_${now}_${Math.random().toString(36).slice(2, 6)}`,
          shooterId: bot.id,
          start: origin,
          end: endPos,
          colorHex: bot.beamHex,
          width: weapon.beamWidth,
          timestamp: now,
        } satisfies BeamVisualEvent);
        if (Math.random() < hitChance) {
          applyDamage(room, target, weapon.damage * 0.62, bot, weapon.name, false);
        }
      }
    }
  } else {
    wishX = -Math.sin(bot.botTargetYaw) * baseSpeed * 0.45;
    wishZ = -Math.cos(bot.botTargetYaw) * baseSpeed * 0.45;
  }

  // Active hazard avoidance (steer clear of telegraphing/active Plasma Pylons & Coolant Vents)
  for (let i = 0; i < map.hazards.length; i++) {
    const hDef = map.hazards[i];
    const hRt = room.hazards[i];
    if (!hRt || hRt.phase === 'idle' || hDef.kind === 'laser_sweeper') continue;
    const hdx = bot.x - hDef.x;
    const hdz = bot.z - hDef.z;
    const hDist = Math.hypot(hdx, hdz);
    const safeRad = hDef.radius + 3.2;
    if (hDist < safeRad) {
      const inv = 1 / Math.max(0.1, hDist);
      const nx = hdx * inv;
      const nz = hdz * inv;
      const urgency = 1.4 - Math.min(1, hDist / safeRad);
      wishX += (nx - nz * 0.45 * bot.botStrafeDir) * baseSpeed * urgency * 1.8;
      wishZ += (nz + nx * 0.45 * bot.botStrafeDir) * baseSpeed * urgency * 1.8;
    }
  }

  // Smooth multi-whisker obstacle avoidance so bots glide smoothly past walls & pillars
  const wishSpeed = Math.min(baseSpeed * 1.15, Math.hypot(wishX, wishZ));
  let targetVx = 0;
  let targetVz = 0;
  if (wishSpeed > 0.05) {
    const steered = computeObstacleAvoidanceDir(
      { x: bot.x, y: bot.y, z: bot.z },
      wishX,
      wishZ,
      colliders,
      map.halfSize,
      3.4,
      otherRobots,
    );
    targetVx = steered.x * wishSpeed;
    targetVz = steered.z * wishSpeed;
  }

  // Exponential velocity smoothing (eliminates choppy velocity steps)
  const velBlend = Math.min(1, dt * 8.5);
  bot.vx += (targetVx - bot.vx) * velBlend;
  bot.vz += (targetVz - bot.vz) * velBlend;

  // Rate-limited smooth angular steering for BOTH gimbal yaw & chassis yaw (never snaps 180deg!)
  bot.yaw = rotateTowardsAngle(bot.yaw, desiredAimYaw, 3.8 * dt);
  bot.pitch += (desiredPitch - bot.pitch) * Math.min(1, dt * 7);

  const moveMag = Math.hypot(bot.vx, bot.vz);
  const desiredChassisYaw = moveMag > 0.6 ? Math.atan2(-bot.vx, -bot.vz) : bot.yaw;
  bot.chassisYaw = rotateTowardsAngle(bot.chassisYaw, desiredChassisYaw, 3.0 * dt);

  const moved = resolvePlayerMovement(
    { x: bot.x, y: bot.y, z: bot.z },
    { x: bot.vx, y: 0, z: bot.vz },
    dt,
    colliders,
    map.halfSize,
    otherRobots,
  );

  // Soft stuck recovery without sudden 180-deg snapping
  const movedDist = Math.hypot(moved.pos.x - bot.botLastX, moved.pos.z - bot.botLastZ);
  bot.botLastX = moved.pos.x;
  bot.botLastZ = moved.pos.z;
  if (wishSpeed > 1.0 && movedDist < 0.03) {
    bot.botStuckTicks += 1;
    if (bot.botStuckTicks >= 14) {
      bot.botStrafeDir *= -1;
      bot.botTargetYaw += 0.95 * bot.botStrafeDir;
      bot.botStuckTicks = 0;
    }
  } else {
    bot.botStuckTicks = 0;
  }

  bot.x = moved.pos.x;
  bot.y = moved.pos.y;
  bot.z = moved.pos.z;
}

function stepRoom(room: ServerRoom, now: number): void {
    if (room.phase !== 'active') return;
    const dt = TICK_MS / 1000;
    const map = MAPS[room.config.mapId];
    const elapsedSec = (now - room.startedAtMs) / 1000;
    if (elapsedSec >= room.durationSec) { endSimulation(room); return; }
    room.serverTick++;
    // Barrier respawn
    for (const b of room.barriers.values()) {
      if (b.destroyed && b.respawnAt > 0 && now >= b.respawnAt) {
        b.destroyed = false;
        b.hp = b.maxHp;
        b.respawnAt = 0;
      }
    }

    // Ore Node respawn
    for (const o of room.oreNodes.values()) {
      if (o.depleted && o.respawnAt > 0 && now >= o.respawnAt) {
        o.depleted = false;
        o.amount = o.maxAmount;
        o.respawnAt = 0;
      }
    }

    const colliders = getArenaActiveColliders(map, Array.from(room.barriers.values()));

    // Update hazards
    const overdrive = room.config.hazardIntensity === 'overdrive';
    room.hazards = map.hazards.map((h) => evaluateHazardState(h, elapsedSec, overdrive));

    // Step combatants, respawns, passive shield regen, hazard damage, bots
    let cobaltOnCore = 0;
    let amberOnCore = 0;

    for (const p of room.players.values()) {
      if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt && room.phase === 'active') {
        const sp = pickSpawnForTeam(room.config.mapId, p.team, room.config.mode);
        const classSpec = ROBOT_CLASSES[p.robotClass];
        const mag = getInitialAmmoForClass(p.robotClass, p.weaponId);
        p.x = sp.x;
        p.y = sp.y;
        p.z = sp.z;
        p.yaw = sp.yaw;
        p.chassisYaw = sp.yaw;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.maxHp = classSpec.maxHp;
        p.maxShield = classSpec.maxShield;
        p.hp = classSpec.maxHp;
        p.shield = classSpec.maxShield;
        p.ammo = mag > 0 ? Math.max(p.ammo, Math.min(mag, 12)) : 0; // Respawn emergency reserve for armed units
        p.maxAmmo = mag;
        p.alive = true;
        p.respawnAt = 0;
        p.miningNodeId = null;
        clearInput(p);
        p.dashing = false;
        p.dashRemaining = 0;
        p.grounded = true;
        p.heat = 0;
        p.overheated = false;
      }

      if (!p.alive) {
        p.miningNodeId = null;
        continue;
      }

      if (!p.isBot) stepHuman(room, p, now, colliders);

      // Clear stale human mining indicator after 250ms idle
      if (!p.isBot && p.miningNodeId && now - p.lastMineAtMs > 260) {
        p.miningNodeId = null;
      }

      // Shield passive recharge
      if (p.shield < p.maxShield) {
        p.shield = Math.min(p.maxShield, p.shield + dt * 3.5);
      }

      // Check environmental hazards
      for (let i = 0; i < map.hazards.length; i++) {
        const def = map.hazards[i];
        const rt = room.hazards[i];
        if (isPlayerHitByHazard({ x: p.x, y: p.y, z: p.z }, def, rt)) {
          if (def.kind === 'coolant_leak') {
            p.slowedUntil = now + 1200;
          }
          if (now - p.lastHazardHitAtMs >= 500) {
            p.lastHazardHitAtMs = now;
            applyDamage(room, p, def.damagePerTick, null, def.label, true);
          }
        }
      }

      if (!p.alive || room.phase !== 'active') continue;

      // Control Core check
      if (room.config.mode === 'control_core' && room.phase === 'active') {
        const distCore = Math.hypot(p.x - map.controlCore.x, p.z - map.controlCore.z);
        if (distCore <= 6.2) {
          if (p.team === 'cobalt') cobaltOnCore++;
          else amberOnCore++;
        }
      }

      if (p.isBot) {
        stepBotAi(room, p, dt, now);
      }
    }

    if (room.config.mode === 'control_core' && room.phase === 'active') {
      if (cobaltOnCore > 0 && amberOnCore === 0) {
        room.controlOwner = 'cobalt';
        room.scoreCobalt += dt * 0.45;
      } else if (amberOnCore > 0 && cobaltOnCore === 0) {
        room.controlOwner = 'amber';
        room.scoreAmber += dt * 0.45;
      } else if (cobaltOnCore > 0 && amberOnCore > 0) {
        room.controlOwner = 'contested';
      }
      if (room.scoreCobalt >= room.scoreLimit || room.scoreAmber >= room.scoreLimit) {
        endSimulation(room);
      }
    }

    // Broadcast authoritative snapshot to connected human clients
    if (room.phase === 'active') broadcastToRoom(room, 'match:state', serializeRoomSnapshot(room));
}

function createCombatant(room: ServerRoom, member: Member): ServerCombatant {
  const { id: playerId, profile, team } = member;
  const safeLoadout = sanitizeLoadoutForXp(profile.loadout, DEFAULT_LOADOUT, profile.stats.xp);
  const spawn = pickSpawnForTeam(room.config.mapId, team, room.config.mode);

  const beamCosmetic = COSMETICS.find((c) => c.id === safeLoadout.beamColorId);
  const skinCosmetic = COSMETICS.find((c) => c.id === safeLoadout.skinId);
  const classSpec = ROBOT_CLASSES[safeLoadout.robotClass];
  const initialAmmo = getInitialAmmoForClass(safeLoadout.robotClass, safeLoadout.weaponId);

  const combatant: ServerCombatant = {
    id: playerId,
    callsign: profile.callsign,
    isBot: false,
    robotClass: safeLoadout.robotClass,
    team,
    platform: profile.platform,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    yaw: spawn.yaw,
    chassisYaw: spawn.yaw,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    hp: classSpec.maxHp,
    maxHp: classSpec.maxHp,
    shield: classSpec.maxShield,
    maxShield: classSpec.maxShield,
    ammo: initialAmmo,
    maxAmmo: initialAmmo,
    alive: true,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    damageDealt: 0,
    oreMined: 0,
    weaponId: safeLoadout.weaponId,
    beamHex: beamCosmetic?.hex || '#06B6D4',
    skinHex: skinCosmetic?.hex || '#262F3F',
    dashing: false,
    shieldActive: false,
    overclocked: false,
    miningNodeId: null,
    slowedUntil: 0,
    speaking: false,
    lastShotAtMs: 0,
    lastGadgetAtMs: 0,
    lastClassSkillAtMs: 0,
    lastMineAtMs: 0,
    shotsFiredMatch: 0,
    shotsHitMatch: 0,
    hazardKillsMatch: 0,
    barriersDestroyedMatch: 0,
    shieldActiveUntil: 0,
    overclockUntil: 0,
    oreFracBuffer: 0,
    lastHazardHitAtMs: 0,
    botTargetYaw: spawn.yaw,
    botDecisionAtMs: 0,
    botStrafeDir: 1,
    botLastX: spawn.x,
    botLastZ: spawn.z,
    botStuckTicks: 0,
    gadgetId: safeLoadout.gadgetId,
    stashedCombatAmmo: canRobotClassFire(safeLoadout.robotClass) ? undefined : getInitialAmmoForClass('s1_striker', safeLoadout.weaponId),
    lastProcessedInputSeq: 0,
    grounded: true,
    dashRemaining: 0,
    dashCooldown: 0,
    heat: 0,
    overheated: false,
  };

  return combatant;
}

function applyCombatProfile(room: ServerRoom, id: string, profile: PlayerProfile): void {
  const member = room.members.get(id);
  const fighter = room.players.get(id);
  if (!member || member.forfeited || !fighter) return;
  const { robotClass, weaponId, gadgetId, skinId, beamColorId } = profile.loadout;
  const combatAmmo = canRobotClassFire(fighter.robotClass) ? fighter.ammo : (fighter.stashedCombatAmmo ?? 0);
  const spec = ROBOT_CLASSES[robotClass];
  fighter.callsign = profile.callsign;
  fighter.robotClass = robotClass;
  fighter.weaponId = weaponId;
  fighter.gadgetId = gadgetId;
  fighter.beamHex = COSMETICS.find(c => c.id === beamColorId)?.hex ?? fighter.beamHex;
  fighter.skinHex = COSMETICS.find(c => c.id === skinId)?.hex ?? fighter.skinHex;
  fighter.maxHp = spec.maxHp;
  fighter.maxShield = spec.maxShield;
  fighter.maxAmmo = getInitialAmmoForClass(robotClass, weaponId);
  fighter.hp = Math.min(fighter.hp, fighter.maxHp);
  fighter.shield = Math.min(fighter.shield, fighter.maxShield);
  fighter.ammo = Math.min(combatAmmo, fighter.maxAmmo);
  fighter.stashedCombatAmmo = canRobotClassFire(robotClass) ? undefined : combatAmmo;
}

// GAMEPLAY_HANDLERS
function gameplay(room: ServerRoom, playerId: string, type: string, payload: Record<string, unknown>): void {
  if (room.phase !== 'active' || !room.matchId || room.matchId !== payload.matchId) return;
  const member = room.members.get(playerId);
  if (!member || member.forfeited || member.detachedAt !== undefined) return;
  const p = room.players.get(playerId);
  if (!p || !p.alive) return;
  if (type !== 'player:input') {
    const seq = payload.actionSeq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= (p.lastActionSeq ?? 0)) return;
    p.lastActionSeq = seq;
  }
  const sendDirect = (wire: string) => emitGame({ type: 'direct', matchId: room.matchId!, playerId, wire });
  switch (type) {
    case 'player:input': {
      const input = readPlayerInput(payload);
      if (!input || input.seq <= (p.lastReceivedInputSeq ?? 0)) return;
      p.lastReceivedInputSeq = input.seq;
      p.input = input;
      p.inputAtMs = Date.now();
      p.dashPending ||= input.dash;
      room.antiCheat.packetsValidated++;
      room.antiCheat.lastCheckAt = p.inputAtMs;
      break;
    }
    case 'player:vent': {
      const now = Date.now();
      if (now - (p.ventAtMs ?? 0) < 1600) return;
      p.ventAtMs = now;
      p.heat = Math.max(0, (p.heat ?? 0) - 45);
      p.overheated = false;
      break;
    }
    case 'player:buy_ammo': {
      if (typeof payload.packId !== 'string' || !Object.hasOwn(AMMO_PACKS, payload.packId)) return;
      const packId = payload.packId as AmmoPackId;
      const credits = getTeamCredits(room, p.team);
      const check = canPurchaseAmmoPack(
        credits,
        packId,
        p.ammo,
        p.maxAmmo,
        p.hp,
        p.maxHp,
        p.shield,
        p.maxShield,
      );
      if (!check.allowed) {
        sendDirect(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: check.reason } }));
        return;
      }

      const pack = AMMO_PACKS[packId];
      addTeamCredits(room, p.team, -pack.cost);
      p.ammo = pack.fullFill ? p.maxAmmo : Math.min(p.maxAmmo, p.ammo + pack.ammoGrant);
      if (pack.healHull > 0) p.hp = Math.min(p.maxHp, p.hp + pack.healHull);
      if (pack.healShield > 0) p.shield = Math.min(p.maxShield, p.shield + pack.healShield);
      if (pack.resetHeat) { p.heat = 0; p.overheated = false; }
      if (packId === 'overcharge_cell') {
        p.overclockUntil = Date.now() + 5500;
      }
      sendDirect(
        JSON.stringify({
          type: 'economy:notice',
          payload: {
            ok: true,
            packId,
            ammo: p.ammo,
            maxAmmo: p.maxAmmo,
            resetHeat: pack.resetHeat,
            teamCredits: getTeamCredits(room, p.team),
          },
        }),
      );
      break;
    }

    case 'player:mine': {
      const now = Date.now();
      if (now - p.lastMineAtMs < 90) return;
      const dtMine = p.lastMineAtMs ? Math.min(0.15, (now - p.lastMineAtMs) / 1000) : 0.09;
      p.lastMineAtMs = now;

      let bestNode: OreNodeState | null = null;
      let bestDist = ORE_MINE_RADIUS + 1.5;
      for (const ore of room.oreNodes.values()) {
        if (ore.depleted || ore.amount <= 0) continue;
        const d = Math.hypot(ore.x - p.x, ore.z - p.z);
        if (d <= bestDist) {
          bestDist = d;
          bestNode = ore;
        }
      }

      if (!bestNode) {
        p.miningNodeId = null;
        return;
      }

      p.miningNodeId = bestNode.id;
      const classSpec = ROBOT_CLASSES[p.robotClass];
      const boost = p.overclockUntil > now ? 1.85 : 1.0;
      const { extracted } = extractOreFromNode(bestNode, classSpec.miningRatePerSec * boost, dtMine, now);
      if (extracted > 0) {
        p.oreFracBuffer += extracted;
        if (p.oreFracBuffer >= 1) {
          const whole = Math.floor(p.oreFracBuffer);
          p.oreFracBuffer -= whole;
          p.oreMined += whole;
          addTeamCredits(room, p.team, whole);
        }
      }
      break;
    }

    case 'player:class_skill': {
      const now = Date.now();
      const classSpec = ROBOT_CLASSES[p.robotClass];
      if (now < (p.classSkillReadyAtMs ?? 0)) {
        room.antiCheat.rateLimitBlocks += 1;
        return;
      }
      p.lastClassSkillAtMs = now;
      p.classSkillReadyAtMs = now + classSpec.classSkillCooldownSec * 1000;
      p.overclockUntil = now + 5000;
      if (p.robotClass === 's1_striker') { p.heat = 0; p.overheated = false; }

      if (p.robotClass === 'ep_miner') {
        // Repair pulse for self + nearby teammates within 12m
        for (const mate of room.players.values()) {
          if (!mate.alive || mate.team !== p.team) continue;
          const d = Math.hypot(mate.x - p.x, mate.z - p.z);
          if (d <= 12) {
            mate.shield = Math.min(mate.maxShield, mate.shield + 35);
            mate.hp = Math.min(mate.maxHp, mate.hp + 20);
          }
        }
      }
      break;
    }

    case 'player:gadget': {
      const gadgetId = p.gadgetId ?? 'phase_dash';
      const spec = GADGETS[gadgetId];
      const now = Date.now();
      if (now < (p.gadgetReadyAtMs ?? 0)) {
        room.antiCheat.rateLimitBlocks += 1;
        return;
      }
      p.lastGadgetAtMs = now;
      p.gadgetReadyAtMs = now + spec.cooldownSec * 1000;

      if (gadgetId === 'phase_dash') {
        p.phaseDashPending = true;
      } else if (gadgetId === 'aegis_wall') {
        p.shieldActiveUntil = now + 3500;
        p.shield = Math.min(p.maxShield, p.shield + 25);
      } else if (gadgetId === 'emp_pulse') {
        for (const other of room.players.values()) {
          if (!other.alive || other.id === p.id) continue;
          if (room.config.mode !== 'ffa' && other.team === p.team) continue;
          const dist = Math.hypot(other.x - p.x, other.z - p.z);
          if (dist <= 11) {
            other.shield = 0;
            other.slowedUntil = now + 1500;
            applyDamage(room, other, 22, p, GADGETS.emp_pulse.name, false);
          }
        }
      }
      break;
    }

    case 'player:fire': {
      if (!canRobotClassFire(p.robotClass)) {
        sendDirect(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: 'ep_no_weapon' } }));
        return;
      }

      if (p.overheated) return;
      if (p.ammo <= 0) {
        sendDirect(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: 'no_ammo' } }));
        return;
      }

      const now = Date.now();
      const weapon = WEAPONS[p.weaponId] || WEAPONS.pulse_carbine;
      const overclockMult = p.overclockUntil > now ? 0.65 : 1.0;
      room.antiCheat.packetsValidated += 1;

      const cadence = validateFireCadence(p.lastShotAtMs, now, weapon.fireIntervalMs * overclockMult);
      if (!cadence.allowed) {
        room.antiCheat.rateLimitBlocks += 1;
        return;
      }

      const aim = readPlayerAim(payload) ?? { yaw: p.yaw, pitch: p.pitch, ads: p.ads ?? false };
      p.yaw = aim.yaw;
      p.pitch = aim.pitch;
      p.ads = aim.ads;
      p.lastShotAtMs = now;
      p.ammo = Math.max(0, p.ammo - 1);
      p.shotsFiredMatch += 1;
      p.heat = Math.min(100, (p.heat ?? 0) + weapon.heatPerShot);
      p.overheated = p.heat >= 100;

      const map = MAPS[room.config.mapId];
      const colliders = getArenaActiveColliders(map, Array.from(room.barriers.values()));
      const targets = Array.from(room.players.values()).filter(other => other.alive && other.id !== p.id);
      const { origin, dir: baseDir } = computePlayerShot(p, aim, weapon.range, colliders, targets, map.halfSize);

      const pelletCount = Math.max(1, weapon.pellets);
      const damageByTarget = new Map<ServerCombatant, number>();
      let anyTargetHit = false;
      let primaryEndPos: Vec3 | null = null;

      for (let pellet = 0; pellet < pelletCount; pellet++) {
        let dir = baseDir;
        if (weapon.spreadRad > 0) {
          const rx = baseDir.x + (Math.random() - 0.5) * weapon.spreadRad * 1.4;
          const ry = baseDir.y + (Math.random() - 0.5) * weapon.spreadRad * 1.4;
          const rz = baseDir.z + (Math.random() - 0.5) * weapon.spreadRad * 1.4;
          const rLen = Math.hypot(rx, ry, rz) || 1;
          dir = { x: rx / rLen, y: ry / rLen, z: rz / rLen };
        }

        let maxRayDist = weapon.range;
        let hitBarrierId: string | null = null;
        let hitBarrierDist = Infinity;

        for (const col of colliders) {
          const t = rayIntersectAabb(origin, dir, col, weapon.range);
          if (t !== null && t < maxRayDist) {
            maxRayDist = t;
            if (col.destructible) {
              hitBarrierId = col.id;
              hitBarrierDist = t;
            } else {
              hitBarrierId = null;
            }
          }
        }

        let hitTarget: ServerCombatant | null = null;
        let hitTargetDist = maxRayDist;

        for (const other of room.players.values()) {
          if (!other.alive || other.id === p.id) continue;
          if (!room.config.friendlyFire && room.config.mode !== 'ffa' && other.team === p.team) continue;
          const hit = rayIntersectRobot(
            origin,
            dir,
            {
              x: other.x,
              y: other.y,
              z: other.z,
              chassisYaw: other.chassisYaw ?? other.yaw,
              aimYaw: other.yaw,
              robotClass: other.robotClass,
            },
            hitTargetDist,
          );
          if (hit !== null && hit.dist < hitTargetDist) {
            hitTargetDist = hit.dist;
            hitTarget = other;
          }
        }

        let finalDist = maxRayDist;
        if (hitTarget) {
          const los = validateShotLineOfSight(origin, dir, hitTargetDist, colliders, weapon.range);
          if (!los.clear) {
            room.antiCheat.losRejections += 1;
          } else {
            finalDist = hitTargetDist;
            anyTargetHit = true;
            damageByTarget.set(hitTarget, (damageByTarget.get(hitTarget) || 0) + weapon.damage);
          }
        } else if (hitBarrierId && hitBarrierDist <= maxRayDist + 0.05) {
          const barrier = room.barriers.get(hitBarrierId);
          if (barrier && !barrier.destroyed) {
            barrier.hp = Math.max(0, barrier.hp - weapon.damage * 1.4);
            if (barrier.hp <= 0) {
              barrier.destroyed = true;
              barrier.respawnAt = now + 18000;
              p.barriersDestroyedMatch += 1;
              broadcastToRoom(room, 'barrier:shatter', { id: barrier.id });
            }
          }
        }

        const pelletEnd: Vec3 = {
          x: origin.x + dir.x * finalDist,
          y: origin.y + dir.y * finalDist,
          z: origin.z + dir.z * finalDist,
        };
        if (pellet === 0) primaryEndPos = pelletEnd;
        if (pellet > 0) {
          broadcastToRoom(room, 'match:beam', {
            id: `b_${now}_${pellet}_${Math.random().toString(36).slice(2, 6)}`,
            shooterId: p.id,
            start: origin,
            end: pelletEnd,
            colorHex: p.beamHex,
            width: weapon.beamWidth,
            timestamp: now,
          } satisfies BeamVisualEvent);
        }
      }

      if (anyTargetHit) {
        p.shotsHitMatch += 1;
        for (const [target, dmg] of damageByTarget.entries()) {
          applyDamage(room, target, dmg, p, weapon.name, false);
          sendDirect(
            JSON.stringify({
              type: 'hit:confirm',
              payload: { targetId: target.id, damage: Math.round(dmg), killed: !target.alive },
            }),
          );
        }
      }

      if (primaryEndPos) {
        const beamEvt: BeamVisualEvent = {
          id: `b_${now}_${Math.random().toString(36).slice(2, 6)}`,
          shooterId: p.id,
          start: origin,
          end: primaryEndPos,
          colorHex: p.beamHex,
          width: weapon.beamWidth,
          timestamp: now,
        };
        broadcastToRoom(room, 'match:beam', beamEvt);
      }
      break;
    }

  }
}

function isCurrent(conn: Connection): boolean {
  return !closing && connections.get(conn.auth.playerId) === conn && conn.ws.readyState === WebSocket.OPEN;
}

function online(member: Member): boolean {
  return !member.forfeited && member.detachedAt === undefined && connections.has(member.id);
}

function minimumPlayers(room: ServerRoom): number {
  return room.publicMatch ? ROOM_SIZE : PRIVATE_ROOM_MIN_PLAYERS;
}

function roomView(room: ServerRoom) {
  const members = [...room.members.values()].filter(m => !m.forfeited);
  return {
    ...room.config,
    playerCount: members.length,
    avgMmr: members.length ? Math.round(members.reduce((n, m) => n + m.profile.stats.mmr, 0) / members.length) : 0,
    publicMatch: room.publicMatch,
    minPlayers: minimumPlayers(room),
    phase: room.phase,
    fillBots: room.fillBots,
    botFill: room.fillBots,
    matchId: room.matchId,
    members: members.map(m => ({ id: m.id, callsign: m.profile.callsign, online: online(m), connected: online(m), team: m.team })),
  };
}

function roomUpdate(room: ServerRoom): void {
  broadcastToRoom(room, 'room:state', { room: roomView(room) });
  for (const member of room.members.values()) if (online(member)) sessionState(connections.get(member.id));
}

function joined(room: ServerRoom, conn: Connection | undefined): void {
  if (!conn || room.phase !== 'active') return;
  const member = room.members.get(conn.auth.playerId);
  if (!member || !online(member)) return;
  const wire = room.matchId && matches.get(room.matchId)?.snapshotWire;
  const snapshot = wire ? (JSON.parse(wire) as {payload: MatchSnapshot}).payload : serializeRoomSnapshot(room);
  send(conn, 'room:joined', { roomId: room.config.roomId, playerId: member.id, team: member.team, snapshot });
}

function clearInput(p: ServerCombatant): void {
  p.input = undefined;
  p.inputAtMs = undefined;
  p.dashPending = false;
  p.phaseDashPending = false;
  p.miningNodeId = null;
  p.speaking = false;
}

function stepHuman(room: ServerRoom, p: ServerCombatant, now: number, colliders: ReturnType<typeof getArenaActiveColliders>): void {
  const weapon = WEAPONS[p.weaponId];
  p.heat = Math.max(0, (p.heat ?? 0) - weapon.coolRatePerSec * (p.overheated ? 1.45 : 1) * TICK_MS / 1000);
  if (p.overheated && p.heat <= 15) p.overheated = false;
  const member = room.members.get(p.id);
  if (!member || member.forfeited) return;
  const command = p.input && now - (p.inputAtMs ?? 0) < 200 && member.detachedAt === undefined
    ? { ...p.input, dash: Boolean(p.dashPending) }
    : null;
  const otherRobots = [...room.players.values()].filter(other => other.id !== p.id && other.alive);
  const motion = stepPlayerMotion(playerMotionFromSnapshot(p), command, {
    colliders, otherRobots, halfSize: MAPS[room.config.mapId].halfSize,
    speedMult: ROBOT_CLASSES[p.robotClass].speedMult, slowed: p.slowedUntil > now,
    phaseDash: p.phaseDashPending, lastAimYaw: p.yaw,
  });
  if (command) {
    p.lastProcessedInputSeq = command.seq;
    p.yaw = command.yaw;
    p.pitch = command.pitch;
    p.ads = command.ads;
  }
  p.dashPending = false;
  p.phaseDashPending = false;
  p.x = motion.pos.x; p.y = motion.pos.y; p.z = motion.pos.z;
  p.vx = motion.vel.x; p.vy = motion.vel.y; p.vz = motion.vel.z;
  p.grounded = motion.grounded;
  p.chassisYaw = motion.chassisYaw;
  p.dashCooldown = motion.dashCooldown;
  p.dashRemaining = motion.dashRemaining;
  p.dashing = motion.dashRemaining > 0;
}

function roomOptions(payload: Record<string, unknown>): Partial<LobbyConfig> & { fillBots?: boolean } {
  const changes: Partial<LobbyConfig> & { fillBots?: boolean } = {};
  if (typeof payload.name === 'string' && payload.name.trim()) changes.name = payload.name.trim().slice(0, 40);
  if (typeof payload.mapId === 'string' && Object.hasOwn(MAPS, payload.mapId)) changes.mapId = payload.mapId as MapId;
  if (payload.mode === 'ffa' || payload.mode === 'control_core' || payload.mode === 'team_clash') changes.mode = payload.mode;
  if (typeof payload.isPrivate === 'boolean') changes.isPrivate = payload.isPrivate;
  if (typeof payload.friendlyFire === 'boolean') changes.friendlyFire = payload.friendlyFire;
  if (payload.hazardIntensity === 'standard' || payload.hazardIntensity === 'overdrive') changes.hazardIntensity = payload.hazardIntensity;
  if (typeof payload.fillBots === 'boolean') changes.fillBots = payload.fillBots;
  else if (typeof payload.botFill === 'boolean') changes.fillBots = payload.botFill;
  return changes;
}

function teamFor(room: ServerRoom): TeamId {
  let cobalt = 0, amber = 0;
  for (const member of room.members.values()) {
    if (member.forfeited) continue;
    if (member.team === 'cobalt') cobalt++; else amber++;
  }
  return cobalt <= amber ? 'cobalt' : 'amber';
}

function addMember(room: ServerRoom, conn: Connection, team = teamFor(room)): void {
  const id = conn.auth.playerId;
  room.members.set(id, { id, profile: conn.profile, team, joinedAt: Date.now() });
  roomByPlayer.set(id, room);
}

function transferHost(room: ServerRoom): void {
  if (room.publicMatch) return;
  const current = room.members.get(room.config.hostId);
  if (current && !current.forfeited) return;
  const next = [...room.members.values()].filter(online).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.config.hostId = next?.id ?? '';
  room.config.hostCallsign = next?.profile.callsign ?? '';
}

function dropMember(room: ServerRoom, id: string): void {
  const member = room.members.get(id);
  if (!member || member.forfeited) return;
  const conn = connections.get(id);
  if (roomByPlayer.get(id) === room) roomByPlayer.delete(id);
  if (room.phase === 'waiting' && !room.starting) {
    room.members.delete(id);
    if (!room.members.size) rooms.delete(room.config.roomId);
  } else {
    member.forfeited = true;
    relaySeat(room, id, 'forfeited');
    const p = room.players.get(id);
    if (p) {
      clearInput(p);
      p.alive = false;
      p.respawnAt = 0;
      p.vx = p.vy = p.vz = 0;
    }
  }
  transferHost(room);
  send(conn, 'room:state', { room: null });
  sessionState(conn);
  roomUpdate(room);
}

function removeExpiredSeats(room: ServerRoom, now: number): void {
  for (const member of room.members.values()) {
    if (!member.forfeited && member.detachedAt !== undefined && now - member.detachedAt >= SEAT_MS) dropMember(room, member.id);
  }
}

function populateArena(room: ServerRoom): void {
  const map = MAPS[room.config.mapId];
  room.players.clear();
  room.barriers.clear();
  room.oreNodes.clear();
  for (const b of map.barriers) room.barriers.set(b.id, { id: b.id, hp: b.maxHp, maxHp: b.maxHp, destroyed: false, respawnAt: 0 });
  for (const o of map.oreNodes) room.oreNodes.set(o.id, { id: o.id, x: o.x, y: o.y, z: o.z, amount: o.maxAmount, maxAmount: o.maxAmount, tier: o.tier, depleted: false, respawnAt: 0 });
  room.hazards = map.hazards.map(h => evaluateHazardState(h, 0, room.config.hazardIntensity === 'overdrive'));
  room.killFeed = [];
  room.antiCheat = { packetsValidated: 0, movementCorrections: 0, rateLimitBlocks: 0, losRejections: 0, integrityStatus: 'verified', lastCheckAt: Date.now() };
  room.scoreCobalt = room.scoreAmber = room.controlProgress = 0;
  room.teamCreditsCobalt = room.teamCreditsAmber = INITIAL_TEAM_CREDITS;
  room.controlOwner = 'neutral';
  room.scoreLimit = room.config.mode === 'ffa' ? 15 : 25;
  room.serverTick = 0;
  for (const member of room.members.values()) room.players.set(member.id, createCombatant(room, member));
  if (room.fillBots && !room.publicMatch) ensureRoomBots(room);
}

async function launch(room: ServerRoom): Promise<boolean> {
  if (closing || room.phase !== 'waiting' || room.starting) return false;
  room.starting = true;
  const roster = [...room.members.values()];
  const minimum = minimumPlayers(room);
  const sameRoster = () => !closing && roster.filter(online).length >= minimum && roster.every(m => !m.forfeited) && roster.length === room.members.size;
  const matchId = randomUUID();
  let opened = false;
  let worker: GameWorker | undefined;
  try {
    if (roster.length < minimum || !sameRoster() || await services.isDraining()) return false;
    const duration = process.env.TEST_MATCH_MS && process.env.NODE_ENV !== 'production'
      ? clampNum(process.env.TEST_MATCH_MS, 1000, MATCH_MS, MATCH_MS) : MATCH_MS;
    room.durationSec = duration / 1000;
    const eligibility = await Promise.all(roster.map(async member => {
      if (!await services.allowPlay(member.id, duration + READY_MS)) return false;
      member.profile = await services.getProfile(member.id);
      return true;
    }));
    if (eligibility.some(ok => !ok) || !sameRoster()) return false;
    worker = gamePool.reserve(matchId);
    if (!worker) return false;
    await services.openMatch(matchId, worker.id, roster.map(m => m.id));
    opened = true;
    if (!sameRoster()) return false;
    room.matchId = matchId;
    room.startedAtMs = Date.now();
    room.matchFinalized = false;
    populateArena(room);
    room.phase = 'active';
    room.terminating = false;
    if (!gamePool.send(worker, { type: 'start', room })) {
      room.phase = 'waiting';
      room.matchId = null;
      return false;
    }
    matches.set(matchId, { room, worker });
    roomUpdate(room);
    for (const member of room.members.values()) joined(room, connections.get(member.id));
    return true;
  } catch (err) {
    console.error('Unable to start match:', err);
    return false;
  } finally {
    if (!matches.has(matchId)) {
      worker?.rooms.delete(matchId);
      if (opened && worker) await services.cancelMatch(matchId, worker.id).catch(err => console.error('Unable to cancel unstarted match:', err));
    }
    room.starting = false;
    if (room.phase === 'waiting') {
      for (const member of room.members.values()) if (member.forfeited) room.members.delete(member.id);
      if (!room.members.size) rooms.delete(room.config.roomId);
    }
  }
}

function releaseRoom(room: ServerRoom, returnToLobby = false): void {
  if (room.matchId) {
    matches.get(room.matchId)?.worker.rooms.delete(room.matchId);
    matches.delete(room.matchId);
  }
  for (const member of room.members.values()) {
    if (member.forfeited || room.publicMatch || returnToLobby) {
      if (roomByPlayer.get(member.id) === room) {
        roomByPlayer.delete(member.id);
        send(connections.get(member.id), 'room:state', { room: null });
        sessionState(connections.get(member.id));
      }
      room.members.delete(member.id);
    }
  }
  room.players.clear();
  room.phase = 'waiting';
  room.matchId = null;
  room.terminating = false;
  if (!room.members.size) {
    rooms.delete(room.config.roomId);
    return;
  }
  transferHost(room);
  roomUpdate(room);
}

async function settleMatch(room: ServerRoom, worker: GameWorker, adjudication?: Adjudication): Promise<void> {
  const matchId = room.matchId;
  if (!matchId || room.matchFinalized || room.phase !== 'active') return;
  room.matchFinalized = true;
  room.phase = 'ended';
  roomUpdate(room);
  const players = [...room.players.values()];
  const outcome = evaluateMatchOutcome(room.config.mode, room.scoreCobalt, room.scoreAmber, players.filter(p => !room.members.get(p.id)?.forfeited).map(p => ({
    id: p.id, callsign: p.callsign, team: p.team, kills: p.kills, deaths: p.deaths,
    damageDealt: p.damageDealt, mmr: room.members.get(p.id)?.profile.stats.mmr ?? 1250,
  })));
  const winningTeam = adjudication === 'cobalt' || adjudication === 'amber' ? adjudication : outcome.winningTeam;
  const draw = !adjudication && room.config.mode !== 'ffa' && Math.floor(room.scoreCobalt) === Math.floor(room.scoreAmber);
  const results: Result[] = [];
  for (const member of room.members.values()) {
    const p = room.players.get(member.id);
    if (!p) continue;
    const won = !draw && !member.forfeited && (room.config.mode === 'ffa' ? outcome.winnerId === p.id : p.team === winningTeam);
    const result = adjudication === 'cancelled' ? 'cancelled' : member.forfeited ? 'forfeit' : draw ? 'draw' : won ? 'win' : 'loss';
    const progressEnabled = room.publicMatch && adjudication !== 'cancelled' && !member.forfeited;
    const xpEarned = progressEnabled ? 80 + p.kills * 18 + (won ? 65 : 20) : 0;
    results.push({ playerId: member.id, summary: {
      matchId, result, ranked: false, isPrivate: room.config.isPrivate, draw: result === 'draw', cancelled: result === 'cancelled', won: result === 'win', mode: room.config.mode,
      winningTeam, winnerName: room.config.mode === 'ffa' ? outcome.winnerName : winningTeam,
      placement: outcome.placements.get(p.id) ?? 0, kills: p.kills, deaths: p.deaths,
      accuracy: p.shotsFiredMatch ? Math.round(p.shotsHitMatch * 100 / p.shotsFiredMatch) : 0,
      mmrDelta: 0, newMmr: member.profile.stats.mmr, xpEarned, newXp: member.profile.stats.xp,
      scoreCobalt: Math.round(room.scoreCobalt), scoreAmber: Math.round(room.scoreAmber),
    }, ...(progressEnabled ? { progress: {
      mapId: room.config.mapId, mode: room.config.mode, won, draw,
      kills: p.kills, deaths: p.deaths, assists: p.assists,
      shotsFired: p.shotsFiredMatch, shotsHit: p.shotsHitMatch, damageDealt: p.damageDealt,
      hazardKills: p.hazardKillsMatch, barriersDestroyed: p.barriersDestroyedMatch,
      weaponId: p.weaponId, xpEarned,
    } } : {}) });
  }
  const commit = async (attempt: number): Promise<void> => {
    try {
      if (!worker.ready || matches.get(matchId)?.room !== room) return;
      if (adjudication === 'cancelled') await services.cancelMatch(matchId, worker.id);
      else await services.commitResults(matchId, results, worker.id);
      for (const { playerId, summary } of results) {
        if (roomByPlayer.get(playerId) === room) send(connections.get(playerId), 'match:summary', summary);
      }
      releaseRoom(room);
    } catch (err) {
      settlementFailures++;
      console.error('Unable to commit match:', err);
      if (closing || !worker.ready || matches.get(matchId)?.room !== room) return;
      if (attempt < 4) setTimeout(() => void commit(attempt + 1), 1000 * 2 ** attempt).unref();
      else {
        try {
          await services.cancelMatch(matchId, worker.id);
        } catch (cancelError) { console.error('Unable to cancel uncommitted match:', cancelError); }
        await abandonRoom(room, matchId);
      }
    }
  };
  await commit(0);
}

function evaluateForfeits(room: ServerRoom): void {
  if (room.phase !== 'active') return;
  const remaining = [...room.members.values()].filter(m => !m.forfeited);
  if (!remaining.length) { requestFinish(room, 'cancelled'); return; }
  if (!room.publicMatch) return;
  const cobalt = remaining.some(m => m.team === 'cobalt');
  const amber = remaining.some(m => m.team === 'amber');
  if (!cobalt || !amber) requestFinish(room, cobalt ? 'cobalt' : 'amber');
}

function queueState(id: string, knownPosition?: number) {
  const ready = readyByPlayer.get(id);
  if (ready) return { status: 'ready', readyId: ready.id, deadline: ready.deadline, accepted: ready.accepted.has(id), acceptedCount: ready.accepted.size, total: ready.entries.length };
  if (!queue.has(id)) return { status: 'idle' };
  const position = knownPosition ?? [...queue.values()].sort((a, b) => a.order - b.order).findIndex(entry => entry.id === id) + 1;
  return { status: 'queued', position };
}

function queueUpdate(ids: Iterable<string>): void {
  const affected = [...new Set(ids)];
  const added = affected.flatMap(id => queue.has(id) ? [queue.get(id)!] : []);
  void services.lobby.updateQueue(OWNER_ID, added, affected.filter(id => !queue.has(id)))
    .catch(error => console.error('Could not update queue index:', error));
  const position = new Map([...queue.values()].sort((a, b) => a.order - b.order).map((entry,index) => [entry.id, index + 1]));
  for (const id of affected) {
    const conn = connections.get(id);
    const state = queueState(id, position.get(id));
    send(conn, 'queue:state', state);
    sessionState(conn, state);
  }
}

function clearReady(ready: ReadyCheck): void {
  pendingReady.delete(ready.id);
  for (const entry of ready.entries) if (readyByPlayer.get(entry.id) === ready) readyByPlayer.delete(entry.id);
}

function cancelReady(ready: ReadyCheck, excluded?: string): void {
  if (pendingReady.get(ready.id) !== ready) return;
  clearReady(ready);
  for (const entry of ready.entries) {
    const conn = connections.get(entry.id);
    if (entry.id !== excluded && ready.accepted.has(entry.id) && conn && isCurrent(conn) && !roomByPlayer.has(entry.id)) queue.set(entry.id, entry);
  }
  queueUpdate([...ready.entries.map(entry => entry.id), ...queue.keys()]);
}

async function makeReady(now: number): Promise<void> {
  if (closing || queue.size < ROOM_SIZE || await services.isDraining()) return;
  const order = await services.lobby.queueOrder(OWNER_ID);
  if (closing) return;
  const entries = order.flatMap(id => {
    const entry = queue.get(id);
    const conn = connections.get(id);
    return entry && conn && isCurrent(conn) ? [entry] : [];
  });
  const remaining: string[] = [];
  for (let i = 0; i + ROOM_SIZE <= entries.length; i += ROOM_SIZE) {
    const ready: ReadyCheck = { id: randomUUID(), entries: entries.slice(i, i + ROOM_SIZE), accepted: new Set(), deadline: now + READY_MS, starting: false };
    pendingReady.set(ready.id, ready);
    for (const entry of ready.entries) { queue.delete(entry.id); readyByPlayer.set(entry.id, ready); remaining.push(entry.id); }
  }
  queueUpdate([...remaining, ...queue.keys()]);
}

// Serialize successful public launches to rotate arena maps in launch order.
let publicLaunches = Promise.resolve();
function launchReady(ready: ReadyCheck): void {
  if (ready.starting) return;
  ready.starting = true;
  publicLaunches = publicLaunches.then(async () => {
    if (pendingReady.get(ready.id) !== ready || closing) return;
    const seats = ready.entries.map(entry => connections.get(entry.id));
    if (seats.some(conn => !conn || !isCurrent(conn))) { cancelReady(ready); return; }
    const room = createRoom({ name: 'Public Team Clash', mapId: nextPublicMap % 2 === 0 ? 'reactor_foundry' : 'cryo_relay', mode: 'team_clash', isPrivate: false, publicMatch: true });
    for (const conn of seats) if (conn) addMember(room, conn);
    const started = await launch(room);
    if (started) {
      nextPublicMap++;
      clearReady(ready);
      queueUpdate(ready.entries.map(entry => entry.id));
    } else {
      for (const member of room.members.values()) {
        if (roomByPlayer.get(member.id) === room) roomByPlayer.delete(member.id);
        send(connections.get(member.id), 'room:state', { room: null });
        sessionState(connections.get(member.id));
      }
      rooms.delete(room.config.roomId);
      cancelReady(ready);
    }
  }).catch(err => { console.error('Unable to open public match:', err); cancelReady(ready); });
}

function sessionState(conn: Connection | undefined, state?: ReturnType<typeof queueState>): void {
  if (!conn) return;
  const id = conn.auth.playerId;
  const room = roomByPlayer.get(id);
  const ready = readyByPlayer.get(id);
  send(conn, 'session:state', {
    playerId: id, room: room ? roomView(room) : null, queue: state ?? queueState(id),
    queuedAt: queue.get(id)?.queuedAt ?? null,
    offer: ready ? { offerId: ready.id, expiresAt: ready.deadline, accepted: ready.accepted.has(id), acceptedCount: ready.accepted.size } : null,
  });
}

function errorTo(conn: Connection, action: string, code: string): void {
  send(conn, 'session:error', { action, code, message: code });
}

async function handleCommand(conn: Connection, type: string, payload: Record<string, unknown>): Promise<void> {
  const id = conn.auth.playerId;
  const err = (code: string) => errorTo(conn, type, code);
  const room = () => roomByPlayer.get(id);
  const busy = () => roomByPlayer.has(id) || queue.has(id) || readyByPlayer.has(id);
  const allowed = async (minMs = 0) => (await services.allowPlay(id, minMs)) && isCurrent(conn);
  switch (type) {
    case 'queue:join':
    case 'mmq:join': {
      if (queue.has(id) || readyByPlayer.has(id)) { sessionState(conn); return; }
      if (busy()) { err('busy'); return; }
      if (await services.isDraining()) { err('unavailable'); return; }
      if (!await allowed(MATCH_MS + READY_MS)) { err('ineligible'); return; }
      queue.set(id, { id, queuedAt: Date.now(), order: ++queueOrder, profile: conn.profile });
      queueUpdate([...queue.keys()]);

      return;
    }
    case 'queue:leave':
    case 'mmq:leave': {
      if (queue.delete(id)) queueUpdate([...queue.keys(), id]);
      const ready = readyByPlayer.get(id);
      if (ready && !ready.starting) cancelReady(ready, id);
      return;
    }
    case 'queue:confirm':
    case 'queue:accept':
    case 'mmq:accept':
    case 'mmq:decline':
    case 'queue:decline': {
      const ready = readyByPlayer.get(id);
      const offerId = payload.readyId ?? payload.offerId;
      if (!ready || ready.id !== offerId || ready.starting || ready.deadline <= Date.now()) { err('stale_ready'); return; }
      const accept = type === 'queue:accept' || type === 'mmq:accept' || (type === 'queue:confirm' && payload.accept === true);
      if (!accept) { cancelReady(ready, id); return; }
      if (!await allowed(MATCH_MS + Math.max(0, ready.deadline - Date.now()))) { cancelReady(ready, id); err('ineligible'); return; }
      if (readyByPlayer.get(id) !== ready || ready.deadline <= Date.now() || ready.starting) return;
      ready.accepted.add(id);
      queueUpdate(ready.entries.map(entry => entry.id));
      if (ready.accepted.size === ROOM_SIZE) launchReady(ready);
      return;
    }
    case 'room:create': {
      if (busy()) { err('busy'); return; }
      if (await services.isDraining()) { err('unavailable'); return; }
      if (!await allowed()) { err('ineligible'); return; }
      const created = createRoom({ ...roomOptions(payload), isPrivate: true, hostId: id, hostCallsign: conn.profile.callsign });
      addMember(created, conn);
      roomUpdate(created);
      return;
    }
    case 'room:join': {
      if (busy()) { err('busy'); return; }
      if (await services.isDraining()) { err('unavailable'); return; }
      if (!await allowed()) { err('ineligible'); return; }
      const code = payload.roomId ?? payload.code;
      const target = typeof code === 'string' && code.length <= 24 ? rooms.get(code.trim().toUpperCase()) : undefined;
      if (!target || target.publicMatch) { err('room_not_found'); return; }
      if (target.phase !== 'waiting' || target.starting) { err('match_locked'); return; }
      if (target.members.size >= ROOM_SIZE) { err('room_full'); return; }
      addMember(target, conn);
      transferHost(target);
      roomUpdate(target);
      return;
    }
    case 'room:leave': {
      const target = room();
      if (target) { dropMember(target, id); evaluateForfeits(target); }
      return;
    }
    case 'room:settings':
    case 'room:update':
    case 'room:start': {
      const target = room();
      if (!target || target.publicMatch) { err('room_not_found'); return; }
      if (target.phase !== 'waiting' || target.starting) { err('match_locked'); return; }
      if (target.config.hostId !== id) { err('not_host'); return; }
      if (type !== 'room:start') {
        if (!await allowed() || room() !== target || target.phase !== 'waiting' || target.starting || target.config.hostId !== id) { err('unavailable'); return; }
        const { fillBots, ...changes } = roomOptions(payload);
        Object.assign(target.config, changes, { isPrivate: true });
        target.fillBots = fillBots ?? target.fillBots;
        roomUpdate(target);
        return;
      }
      const onlineSeats = [...target.members.values()].filter(online);
      if (onlineSeats.length < minimumPlayers(target)) { err('need_two_players'); return; }
      if (!await launch(target)) err('unavailable');
      return;
    }
    case 'chat:send': {
      const target = room();
      const member = target?.members.get(id);
      if (!target || !member || !online(member)) return;
      const msg = await services.chat.send(target.config.roomId, id, member.profile.callsign, payload.text);
      if (!msg) { err('chat_rejected'); return; }
      if (!isCurrent(conn) || room() !== target) return;
      const recipients = [...target.members.values()].filter(online).map(member => member.id);
      const blocked = await services.chat.blockedBy(recipients, id);
      const allowedRecipients = recipients.filter(recipient => !blocked.has(recipient));
      await services.chat.delivered(msg.id, allowedRecipients);
      if (!isCurrent(conn) || room() !== target) return;
      for (const recipient of allowedRecipients) {
        const seat = target.members.get(recipient);
        if (seat && online(seat)) send(connections.get(recipient), 'chat:msg', { ...msg, sender: msg.callsign, team: member.team });
      }
      return;
    }
  }
}

function detach(conn: Connection): void {
  const id = conn.auth.playerId;
  if (connections.get(id) !== conn) return;
  connections.delete(id);
  if (queue.delete(id)) queueUpdate([...queue.keys(), id]);
  const ready = readyByPlayer.get(id);
  if (ready && !ready.starting) cancelReady(ready, id);
  const room = roomByPlayer.get(id);
  const member = room?.members.get(id);
  if (!room || !member || member.forfeited) return;
  member.detachedAt = Date.now();
  relaySeat(room, id, 'disconnected');
  const p = room.players.get(id);
  if (p) { clearInput(p); p.dashing = false; p.dashRemaining = 0; p.vx = 0; p.vz = 0; }
  roomUpdate(room);
}

async function recheck(conn: Connection): Promise<void> {
  if (conn.eligibilityCheck || !isCurrent(conn)) return;
  conn.eligibilityCheck = true;
  try {
    const id = conn.auth.playerId;
    const [auth, playUntil] = await Promise.all([services.authenticate(conn.req), services.playUntil(id)]);
    if (!isCurrent(conn)) return;
    if (playUntil <= Date.now()) disqualify(conn);
    else if (!auth) expireSession(conn);
    else conn.playUntil = playUntil;
  } catch (err) {
    console.error('Session validation failed:', err);
    if (isCurrent(conn)) { detach(conn); conn.ws.close(1011, 'Session validation unavailable'); }
  } finally { conn.eligibilityCheck = false; }
}

function disqualify(conn: Connection): void {
  const id = conn.auth.playerId;
  const room = roomByPlayer.get(id);
  if (room) { dropMember(room, id); evaluateForfeits(room); }
  expireSession(conn);
}

function expireSession(conn: Connection): void {
  detach(conn);
  conn.ws.close(4401, 'Session unavailable');
}

function acceptSocket(ws: WebSocket, req: http.IncomingMessage, auth: Auth, profile: PlayerProfile, playUntil: number): void {
  const id = auth.playerId;
  const previous = connections.get(id);
  const conn: Connection = { ws, auth, req, profile, playUntil, windowAt: Date.now(), packets: 0, commands: 0, pendingCommands: 0, commandChain: Promise.resolve(), eligibilityCheck: false, alive: true };
  connections.set(id, conn);
  previous?.ws.close(4409, 'Session superseded');
  const room = roomByPlayer.get(id);
  if (room) {
    removeExpiredSeats(room, Date.now());
    evaluateForfeits(room);
    const member = room.members.get(id);
    if (member && !member.forfeited) {
      member.detachedAt = undefined;
      relaySeat(room, id, 'joined');
      if (room.phase === 'waiting') member.profile = profile;
      const p = room.players.get(id);
      if (p) {
        clearInput(p);
        // Feed the last acknowledgement back to a replacement client without losing the combatant.
        p.lastReceivedInputSeq = p.lastProcessedInputSeq ?? 0;
        p.vx = p.vz = 0;
        p.dashRemaining = 0;
        p.dashing = false;
      }
    }
  }
  sessionState(conn);
  if (room && roomByPlayer.get(id) === room) { roomUpdate(room); joined(room, conn); }

  ws.on('pong', () => { conn.alive = true; });
  ws.on('error', () => detach(conn));
  ws.on('close', () => detach(conn));
  ws.on('message', (raw, binary) => {
    if (!isCurrent(conn)) return;
    const now = Date.now();
    if (conn.playUntil <= now) { disqualify(conn); return; }
    if (now - conn.windowAt >= 1000) { conn.windowAt = now; conn.packets = conn.commands = 0; }
    if (++conn.packets > 100) { ws.close(4408, 'Message rate exceeded'); return; }
    if (binary) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); } catch { return; }
    if (typeof parsed !== 'object' || !parsed) return;
    const { type, payload } = parsed as Record<string, unknown>;
    if (typeof type !== 'string' || type.length > 32 || (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload)))) return;
    const data = (payload ?? {}) as Record<string, unknown>;
    if (type === 'ping') { send(conn, 'pong', { clientTime: typeof data.clientTime === 'number' ? data.clientTime : now, serverTime: now }); return; }
    if (type.startsWith('player:')) {
      const room = roomByPlayer.get(id);
      if (room?.phase === 'active' && !room.terminating && room.matchId && data.matchId === room.matchId) {
        const match = matches.get(room.matchId);
        if (match) gamePool.send(match.worker, { type: 'input', matchId: room.matchId, playerId: id, action: type, payload: data });
      }
      return;
    }
    if (++conn.commands > 12 || conn.pendingCommands >= 8) { errorTo(conn, type, 'rate_limited'); return; }
    conn.pendingCommands++;
    conn.commandChain = conn.commandChain.then(async () => {
      if (isCurrent(conn)) await handleCommand(conn, type, data);
    }).catch(err => {
      console.error('Socket command failed:', type, err);
      errorTo(conn, type, 'unavailable');
    }).finally(() => { conn.pendingCommands--; });
  });
}

function updateLiveProfile(id: string, profile: PlayerProfile): void {
  const conn = connections.get(id);
  if (conn) conn.profile = profile;
  const room = roomByPlayer.get(id);
  const member = room?.members.get(id);
  if (!room || !member || room.phase === 'ended' || room.starting) return;
  member.profile = profile;
  if (room.phase === 'active' && room.matchId && !room.terminating) {
    const match = matches.get(room.matchId);
    if (match) gamePool.send(match.worker, { type: 'profile', matchId: room.matchId, playerId: id, profile });
  }
  if (room.config.hostId === id) room.config.hostCallsign = profile.callsign;
  roomUpdate(room);
}

let snapshotBackpressure = false;
let inputProcessingMs = 0;
const simulatedRooms = new Map<string, ServerRoom>();

function emitGame(message: GameEvent): void {
  if (!process.connected || !process.send) return;
  const writable = process.send(message, err => {
    if (err) process.exit(1);
    snapshotBackpressure = false;
  });
  if (!writable) snapshotBackpressure = true;
}

function endSimulation(room: ServerRoom, adjudication?: Adjudication): void {
  const matchId = room.matchId;
  if (!matchId || room.phase !== 'active') return;
  room.phase = 'ended';
  // Let the current hit or tick finish updating its counters before transferring the result.
  queueMicrotask(() => {
    simulatedRooms.delete(matchId);
    emitGame({ type: 'finish', matchId, room, adjudication });
  });
}

function startSimulation(): void {
  const stats = measureTicks();
  process.on('disconnect', () => process.exit(0));
  const receiveCommand = (cmd: GameCommand) => {
    if (cmd.type === 'start') {
      const id = cmd.room.matchId;
      if (id && !simulatedRooms.has(id)) simulatedRooms.set(id, cmd.room);
      return;
    }
    const room = simulatedRooms.get(cmd.matchId);
    if (!room || room.phase !== 'active') return;
    if (cmd.type === 'input') gameplay(room, cmd.playerId, cmd.action, cmd.payload);
    else if (cmd.type === 'profile') applyCombatProfile(room, cmd.playerId, cmd.profile);
    else if (cmd.type === 'finish') endSimulation(room, cmd.adjudication);
    else if (cmd.type === 'seat') {
      const member = room.members.get(cmd.playerId);
      const p = room.players.get(cmd.playerId);
      if (!member || !p || member.forfeited) return;
      member.detachedAt = cmd.status === 'joined' ? undefined : Date.now();
      member.forfeited = cmd.status === 'forfeited';
      clearInput(p);
      p.vx = p.vz = 0;
      p.dashRemaining = 0;
      p.dashing = false;
      if (member.forfeited) { p.alive = false; p.respawnAt = 0; p.vy = 0; }
      if (cmd.status === 'joined') {
        p.lastReceivedInputSeq = p.lastProcessedInputSeq ?? 0;
        p.lastActionSeq = 0;
      }
    }
  };
  process.on('message', (cmd: GameCommand) => {
    const start = performance.now();
    receiveCommand(cmd);
    inputProcessingMs += performance.now() - start;
  });
  setInterval(() => {
    if (!simulatedRooms.size) return;
    const start = performance.now();
    const now = Date.now();
    for (const room of simulatedRooms.values()) stepRoom(room, now);
    stats.add(performance.now() - start + inputProcessingMs);
    inputProcessingMs = 0;
  }, TICK_MS);
  setInterval(() => emitGame({ type: 'metrics', stats: stats.report(simulatedRooms.size) }), 1000);
  emitGame({ type: 'ready' });
}

function relaySeat(room: ServerRoom, playerId: string, status: 'joined' | 'disconnected' | 'forfeited'): void {
  if (room.phase !== 'active' || !room.matchId) return;
  const match = matches.get(room.matchId);
  if (match) gamePool.send(match.worker, { type: 'seat', matchId: room.matchId, playerId, status });
}

function requestFinish(room: ServerRoom, adjudication: Adjudication): void {
  if (room.terminating || !room.matchId) return;
  const match = matches.get(room.matchId);
  if (!match) return;
  room.terminating = true;
  gamePool.send(match.worker, { type: 'finish', matchId: room.matchId, adjudication });
}

function handleGameEvent(worker: GameWorker, event: GameEvent): void {
  if (event.type === 'ready' || event.type === 'metrics') return;
  const match = matches.get(event.matchId);
  if (!match || match.worker !== worker || match.room.phase !== 'active') return;
  const room = match.room;
  if (event.type === 'broadcast') {
    if (event.snapshot) match.snapshotWire = event.wire;
    broadcastWire(room, event.wire);
  } else if (event.type === 'direct') {
    const conn = connections.get(event.playerId);
    const seat = room.members.get(event.playerId);
    if (conn && seat && online(seat) && isCurrent(conn) && conn.ws.bufferedAmount <= MAX_SEND_BUFFER) conn.ws.send(event.wire);
  } else if (event.type === 'finish') {
    room.players = event.room.players;
    room.scoreCobalt = event.room.scoreCobalt;
    room.scoreAmber = event.room.scoreAmber;
    const remaining = [...room.members.values()].filter(m => !m.forfeited);
    let decision = event.adjudication;
    if (!remaining.length) decision = 'cancelled';
    else if (room.publicMatch) {
      const cobalt = remaining.some(m => m.team === 'cobalt');
      const amber = remaining.some(m => m.team === 'amber');
      if (!cobalt || !amber) decision = cobalt ? 'cobalt' : 'amber';
    }
    void settleMatch(room, worker, decision);
  }
}

async function abandonRoom(room: ServerRoom, matchId: string): Promise<void> {
  if (room.matchId !== matchId) return;
  room.terminating = true;
  room.phase = 'ended';
  await Promise.all([...room.members.values()].map(async ({id}) => {
    let stored: Awaited<ReturnType<typeof services.getResult>>;
    try { stored = await services.getResult(id, matchId); }
    catch (err) { console.error('Could not look up interrupted match:', err); }
    if (roomByPlayer.get(id) !== room) return;
    const conn = connections.get(id);
    if (stored?.summary) send(conn, 'match:summary', stored.summary);
    else if (stored?.status === 'cancelled') send(conn, 'match:summary', {
        matchId, result: 'cancelled', cancelled: true, isPrivate: !room.publicMatch, ranked: false,
        won: false, mode: room.config.mode, kills: 0, deaths: 0, accuracy: 0, xpEarned: 0,
      });
    else if (conn) errorTo(conn, 'match:result', 'result_pending');
  }));
  if (room.matchId === matchId) releaseRoom(room, true);
}

async function loseWorker(worker: GameWorker): Promise<void> {
  workerFailures++;
  const affected = [...worker.rooms].flatMap(id => {
    const match = matches.get(id);
    return match?.worker === worker ? [{ id, room: match.room }] : [];
  });
  for (const match of affected) match.room.terminating = true;
  console.error('Game worker disconnected:', worker.slot, 'affected matches:', affected.length);
  try { await services.revokeOwner(worker.id); }
  catch (err) { console.error('Could not revoke game worker lease; it will expire:', err); }
  await Promise.all(affected.map(match => abandonRoom(match.room, match.id)));
}

async function startServer(): Promise<void> {
  services = await makeServices((id, by) => {
    const key = by + ':' + id;
    const epoch = ++revocationEpoch;
    revocations.set(key, epoch);
    setTimeout(() => { if (revocations.get(key) === epoch) revocations.delete(key); }, 30_000).unref();
    const conn = by === 'session' ? [...connections.values()].find(c => c.auth.sessionId === id) : connections.get(id);
    if (by === 'ban') {
      // A disconnected account may still hold a resumable seat.
      const room = roomByPlayer.get(id);
      if (room) { dropMember(room, id); evaluateForfeits(room); }
    }
    if (conn) expireSession(conn);
  });
  await services.lobby.claim(OWNER_ID);
  const expectedWorkers = Math.round(clampNum(process.env.GAME_WORKERS ?? Math.min(4, availableParallelism()), 1, 32, 2));
  gamePool = createGamePool<GameCommand, GameEvent>({
    entry: __filename,
    count: expectedWorkers,
    claim: services.renewOwner,
    onEvent: handleGameEvent,
    onFailure: worker => void loseWorker(worker),
  });
  await services.reap();
  const app = express();
  const trustedProxy = process.env.TRUST_PROXY;
  if (trustedProxy) app.set('trust proxy', /^\d+$/.test(trustedProxy) ? Number(trustedProxy) : trustedProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '24kb' }));
  services.install(app);

  const ticks: number[] = [];
  app.get('/api/health', (_req, res) => {
    void services.health().then(() => {
      const sorted = ticks.slice().sort((a, b) => a - b);
      const quantile = (fraction: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0).toFixed(2));
      const workers = gamePool.inspect();
      const gameStatus = { ok: !closing && workers.some(w => w.ready), workers, rooms: rooms.size, activeRooms: [...rooms.values()].filter(r => r.phase === 'active').length, connections: connections.size, onlineLimit: ONLINE_LIMIT, tickP50Ms: quantile(0.5), tickP95Ms: quantile(0.95), tickP99Ms: quantile(0.99) };
      res.status(gameStatus.ok ? 200 : 503).json(gameStatus);
    }).catch(() => res.status(503).json({ ok: false }));
  });
  app.get('/metrics', (_req, res) => {
    const workers = gamePool.inspect();
    void services.health().then(() => 1, () => 0).then(available => {
      res.type('text/plain; version=0.0.4').send([
        'prism_dependencies_ready ' + available,
        'prism_workers_configured ' + expectedWorkers,
        'prism_workers_ready ' + workers.filter(w => w.ready).length,
        'prism_worker_failures_total ' + workerFailures,
        'prism_settlement_failures_total ' + settlementFailures,
        'prism_connections ' + connections.size,
        'prism_online_limit ' + ONLINE_LIMIT,
        'prism_queue_size ' + queue.size,
        ...workers.flatMap(w => [
          'prism_worker_tick_p99_seconds{slot="' + w.slot + '"} ' + (w.tickP99Ms ?? 0) / 1000,
          'prism_worker_rooms{slot="' + w.slot + '"} ' + (w.activeRooms ?? 0),
        ]),
      ].join('\n') + '\n');
    });
  });
  app.get('/api/lobbies', (_req, res) => res.json({ lobbies: [], queueSize: queue.size }));
  app.post('/api/profile', (req, res, next) => {
    void (async () => {
      if (!services.allowOrigin(req)) { res.status(403).json({ error: 'origin' }); return; }
      const auth = await services.authenticate(req);
      if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
      if (!await services.limit('profile:' + auth.playerId, 60, 60)) { res.status(429).json({ error: '修改过于频繁，请稍后再试' }); return; }
      const profile = await services.getProfile(auth.playerId);
      const body = req.body as Partial<PlayerProfile> | undefined;
      if (typeof body?.callsign === 'string' && body.callsign.trim().length >= 2) profile.callsign = body.callsign.trim().slice(0, 18);
      if (body?.loadout) profile.loadout = sanitizeLoadoutForXp(body.loadout, profile.loadout, profile.stats.xp);
      if (body?.controller) {
        const requested = body.controller;
        profile.controller = normalizeControllerConfig({ ...profile.controller, ...requested, bindings: { ...profile.controller.bindings, ...requested.bindings } });
      }
      const saved = await services.saveProfile(auth.playerId, profile);
      updateLiveProfile(auth.playerId, saved);
      res.json(saved);
    })().catch(next);
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true, ...(process.env.NODE_ENV === 'test' ? { hmr: false } : {}) }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  app.use(((err, _req, res, _next) => {
    if (!res.headersSent) res.status(err?.status === 400 || err?.status === 413 ? err.status : 503).json({ error: 'unavailable' });
  }) satisfies import('express').ErrorRequestHandler);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const internalKey = process.env.GAME_WORKER_KEY;
  let connecting = 0;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') return;
    function reject(status: string) { if (!socket.destroyed) socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    if (closing || connecting > 128) { reject('503 Service Unavailable'); return; }
    if (internalKey) {
      const supplied = req.headers['x-game-worker-key'];
      const expected = Buffer.from(internalKey);
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== expected.length || !timingSafeEqual(Buffer.from(supplied), expected)) { reject('403 Forbidden'); return; }
    }
    if (!services.allowOrigin(req)) { reject('403 Forbidden'); return; }
    connecting++;
    const upgradeEpoch = revocationEpoch;
    const upgradeTimeout = setTimeout(() => socket.destroy(), 7000).unref();
    void (async () => {
      const auth = await services.authenticate(req);
      if (!auth) { reject('401 Unauthorized'); return; }
      const playUntil = await services.playUntil(auth.playerId);
      if (playUntil <= Date.now()) { reject('403 Forbidden'); return; }
      const profile = await services.getProfile(auth.playerId);
      if (closing || socket.destroyed) return;
      if ((revocations.get('session:' + auth.sessionId) ?? 0) > upgradeEpoch ||
          (revocations.get('account:' + auth.playerId) ?? 0) > upgradeEpoch ||
          (revocations.get('ban:' + auth.playerId) ?? 0) > upgradeEpoch) { reject('401 Unauthorized'); return; }
      if (connections.size >= ONLINE_LIMIT && !connections.has(auth.playerId)) { reject('503 Service Unavailable'); return; }
      clearTimeout(upgradeTimeout);
      wss.handleUpgrade(req, socket, head, ws => acceptSocket(ws, req, auth, profile, playUntil));
    })().catch(err => {
      console.error('Socket upgrade could not authenticate:', err);
      reject('503 Service Unavailable');
    }).finally(() => { clearTimeout(upgradeTimeout); connecting--; });
  });

  const tickTimer = setInterval(() => {
    const start = performance.now();
    const now = Date.now();
    if (closing) return;
    for (const conn of connections.values()) if (conn.playUntil <= now) disqualify(conn);
    for (const ready of pendingReady.values()) if (!ready.starting && ready.deadline <= now) cancelReady(ready);
    for (const room of rooms.values()) {
      removeExpiredSeats(room, now);
      evaluateForfeits(room);

    }
    ticks.push(performance.now() - start);
    if (ticks.length > 1200) ticks.shift();
  }, TICK_MS);

  let matchmakerBusy = false;
  const matcher = setInterval(() => {
    if (matchmakerBusy || closing || queue.size < ROOM_SIZE) return;
    matchmakerBusy = true;
    void makeReady(Date.now()).catch(err => console.error('Matchmaking unavailable:', err)).finally(() => { matchmakerBusy = false; });
  }, 100);
  let renewBusy = false;
  let leaseRenewedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (renewBusy) return;
    renewBusy = true;
    gamePool.inspect();
    void Promise.all([
      services.lobby.renew(OWNER_ID),
      services.lobby.presence(OWNER_ID, [...connections.keys()]),
      services.lobby.updateQueue(OWNER_ID, [...queue.values()], []),
      ...gamePool.live().map(worker => services.renewOwner(worker.id).catch(err => {
        console.error('Game worker lease expired:', err);
        worker.child.kill('SIGKILL');
      })),
    ]).then(() => { leaseRenewedAt = Date.now(); })
      .catch(err => { console.error('Owner lease renewal failed:', err); if (Date.now() - leaseRenewedAt >= 15_000) void shutdown(); })
      .finally(() => { renewBusy = false; });
  }, 5000);
  let validationIndex = 0;
  const eligibility = setInterval(() => {
    if (closing) return;
    const sockets = [...connections.values()];
    const count = Math.ceil(sockets.length / 15);
    for (let i = 0; i < count; i++) void recheck(sockets[(validationIndex + i) % sockets.length]);
    validationIndex = sockets.length ? (validationIndex + count) % sockets.length : 0;
  }, 1000);
  const presence = setInterval(() => {
    for (const conn of connections.values()) {
      if (!conn.alive) { conn.ws.terminate(); detach(conn); continue; }
      conn.alive = false;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }, 15000);
  const janitor = setInterval(() => void services.reap().catch(err => console.error('Match cleanup failed:', err)), 60_000);

  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    for (const timer of [tickTimer, matcher, heartbeat, eligibility, presence, janitor]) clearInterval(timer);
    for (const conn of connections.values()) { send(conn, 'server:shutdown', { reconnect: true }); conn.ws.close(1012, 'Server restarting'); }
    server.close();
    const forcedExit = setTimeout(() => process.exit(0), 7000).unref();
    const ownerIds = gamePool.live().map(w => w.id);
    gamePool.close();
    await Promise.allSettled([...ownerIds.map(id => services.revokeOwner(id)), services.lobby.release(OWNER_ID)]);
    await services.close();
    clearTimeout(forcedExit);
    process.exit(0);
  }
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log('Prism Breach game server listening on port ' + PORT);
  });
}


if (SIM_WORKER) startSimulation();
else startServer().catch((err) => {
  console.error('Server boot error:', err);
  process.exit(1);
});
