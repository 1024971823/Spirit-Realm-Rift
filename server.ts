import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
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
  normalizePlayerProfile,
  ROBOT_CLASSES,
  sanitizeLoadoutForXp,
  WEAPONS,
} from './src/shared/catalog.ts';
import {
  validateFireCadence,
  validateFireOriginAndDir,
  validateGadgetCooldown,
  validateMovementDelta,
  validateShotLineOfSight,
} from './src/shared/anticheat.ts';
import {
  calculateMmrDelta,
  evaluateMatchOutcome,
  formBalancedMatch,
  pickBalancedTeamForJoiner,
  type QueueCandidate,
} from './src/shared/matchmaking.ts';
import {
  computeObstacleAvoidanceDir,
  evaluateHazardState,
  extractOreFromNode,
  getArenaActiveColliders,
  isPlayerHitByHazard,
  ORE_MINE_RADIUS,
  PLAYER_EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
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
  FriendEntry,
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
const DATA_DIR = path.resolve(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

interface StoreData {
  profiles: Record<string, PlayerProfile>;
  friends: Record<string, FriendEntry[]>;
}

function createDefaultProfile(id: string, callsign = 'Vanguard-01', platform: PlatformType = 'pc'): PlayerProfile {
  return {
    id,
    callsign,
    platform,
    crossplayEnabled: true,
    loadout: { ...DEFAULT_LOADOUT },
    controller: structuredClone(DEFAULT_CONTROLLER),
    stats: {
      matchesPlayed: 12,
      wins: 7,
      losses: 5,
      kills: 138,
      deaths: 94,
      assists: 41,
      shotsFired: 1840,
      shotsHit: 792,
      damageDealt: 19450,
      hazardKills: 9,
      barriersDestroyed: 27,
      mmr: 1285,
      xp: 620,
      credits: 1450,
      weaponStats: {
        pulse_carbine: { kills: 84, shotsFired: 1320, shotsHit: 540, damageDealt: 11200 },
        prism_railgun: { kills: 36, shotsFired: 220, shotsHit: 122, damageDealt: 5850 },
        scatter_projector: { kills: 18, shotsFired: 300, shotsHit: 130, damageDealt: 2400 },
      },
      recentMatches: [
        {
          id: 'seed_m1',
          timestamp: Date.now() - 3600_000 * 5,
          mapId: 'reactor_foundry',
          mode: 'team_clash',
          won: true,
          kills: 14,
          deaths: 7,
          accuracy: 46,
          mmrDelta: 22,
          xpEarned: 185,
        },
        {
          id: 'seed_m2',
          timestamp: Date.now() - 3600_000 * 2,
          mapId: 'cryo_relay',
          mode: 'control_core',
          won: false,
          kills: 11,
          deaths: 10,
          accuracy: 41,
          mmrDelta: -14,
          xpEarned: 120,
        },
      ],
    },
  };
}

const SEED_FRIENDS: FriendEntry[] = [
  { id: 'fr_kaelen', callsign: 'Kaelen-7', platform: 'console', status: 'in_lobby', mmr: 1310, roomId: 'PUBLIC-ALPHA' },
  { id: 'fr_nyx', callsign: 'NyxVector', platform: 'pc', status: 'online', mmr: 1445 },
  { id: 'fr_solaris', callsign: 'SolarisCloud', platform: 'cloud', status: 'in_match', mmr: 1240, roomId: 'PUBLIC-ALPHA' },
  { id: 'fr_orion', callsign: 'OrionIX', platform: 'pc', status: 'offline', mmr: 1190 },
];

function loadStore(): StoreData {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoreData;
      const normalizedProfiles: Record<string, PlayerProfile> = {};
      if (parsed.profiles && typeof parsed.profiles === 'object') {
        for (const [pid, rawProf] of Object.entries(parsed.profiles)) {
          normalizedProfiles[pid] = normalizePlayerProfile(rawProf, pid);
        }
      }
      return {
        profiles: normalizedProfiles,
        friends: parsed.friends || {},
      };
    }
  } catch {
    // Fallback to fresh store
  }
  return { profiles: {}, friends: {} };
}

let store: StoreData = loadStore();

function saveStore(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist store:', err);
  }
}

function getOrCreateProfile(id: string, callsign?: string): PlayerProfile {
  if (!store.profiles[id]) {
    store.profiles[id] = createDefaultProfile(id, callsign || `Prism-${id.slice(-4).toUpperCase()}`);
    store.friends[id] = structuredClone(SEED_FRIENDS);
    saveStore();
  } else {
    store.profiles[id] = normalizePlayerProfile(store.profiles[id], id);
  }
  if (!store.friends[id]) {
    store.friends[id] = structuredClone(SEED_FRIENDS);
  }
  return store.profiles[id];
}

function toFinite(val: unknown, fallback: number): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

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
  lastMoveCheckAtMs: number;
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
  ws?: WebSocket;
}

interface ServerRoom {
  config: LobbyConfig;
  phase: 'active' | 'ended';
  startedAtMs: number;
  lastHumanAtMs: number;
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
  resetTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_PUBLIC_ROOM_IDS = new Set(['PUBLIC-ALPHA', 'PUBLIC-CRYO', 'PUBLIC-FFA']);
const rooms = new Map<string, ServerRoom>();
const clientSockets = new Map<WebSocket, { playerId: string; roomId: string | null }>();
const matchmakingQueue = new Map<string, { candidate: QueueCandidate; mode: GameModeId; mapId: MapId; ws: WebSocket }>();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'PRISM-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(options: Partial<LobbyConfig> & { roomId?: string }): ServerRoom {
  const roomId = options.roomId || generateRoomCode();
  const mapId: MapId = options.mapId && MAPS[options.mapId] ? options.mapId : 'reactor_foundry';
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
      maxPlayers: clampNum(options.maxPlayers, 2, 12, 8),
      hazardIntensity: options.hazardIntensity === 'overdrive' ? 'overdrive' : 'standard',
      friendlyFire: Boolean(options.friendlyFire),
      crossplayPool: options.crossplayPool ?? true,
      playerCount: 0,
      avgMmr: 1250,
    },
    phase: 'active',
    startedAtMs: now,
    lastHumanAtMs: now,
    durationSec: 180,
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
  ensureRoomBots(room);
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
  const targetCombatants = Math.min(6, room.config.maxPlayers);
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
        lastMoveCheckAtMs: Date.now(),
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

  room.config.playerCount = humans.length;
  if (humans.length > 0) {
    const avg = Math.round(
      humans.reduce((acc, h) => acc + (store.profiles[h.id]?.stats.mmr ?? 1250), 0) / humans.length,
    );
    room.config.avgMmr = avg;
  } else {
    room.config.avgMmr = 1250;
  }
}

// Create default public arenas
createRoom({
  roomId: 'PUBLIC-ALPHA',
  name: 'Reactor Foundry · Ranked 3v3',
  mapId: 'reactor_foundry',
  mode: 'team_clash',
  isPrivate: false,
  maxPlayers: 8,
});
createRoom({
  roomId: 'PUBLIC-CRYO',
  name: 'Cryo Relay · Control Core',
  mapId: 'cryo_relay',
  mode: 'control_core',
  isPrivate: false,
  maxPlayers: 8,
});
createRoom({
  roomId: 'PUBLIC-FFA',
  name: 'Reactor Foundry · Free-For-All',
  mapId: 'reactor_foundry',
  mode: 'ffa',
  isPrivate: false,
  maxPlayers: 8,
});

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
  }));

  return {
    roomId: room.config.roomId,
    isPrivate: room.config.isPrivate,
    mapId: room.config.mapId,
    mode: room.config.mode,
    phase: room.phase,
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
    killFeed: room.killFeed.slice(-5),
    antiCheat: room.antiCheat,
  };
}

function broadcastToRoom(room: ServerRoom, type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload });
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
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
      attackerName: attacker ? attacker.callsign : weaponOrHazardLabel,
      attackerTeam: attacker ? attacker.team : 'hazard',
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
        finishMatch(room);
      }
    } else if (room.scoreCobalt >= room.scoreLimit || room.scoreAmber >= room.scoreLimit) {
      finishMatch(room);
    }
  }
}

function resetRoomForNewMatch(room: ServerRoom): void {
  if (!rooms.has(room.config.roomId)) return;
  if (room.resetTimer) {
    clearTimeout(room.resetTimer);
    room.resetTimer = undefined;
  }
  const now = Date.now();
  room.phase = 'active';
  room.matchFinalized = false;
  room.startedAtMs = now;
  room.scoreCobalt = 0;
  room.scoreAmber = 0;
  room.teamCreditsCobalt = INITIAL_TEAM_CREDITS;
  room.teamCreditsAmber = INITIAL_TEAM_CREDITS;
  room.controlOwner = 'neutral';
  room.controlProgress = 0;
  room.killFeed = [];
  for (const b of room.barriers.values()) {
    b.hp = b.maxHp;
    b.destroyed = false;
    b.respawnAt = 0;
  }
  for (const o of room.oreNodes.values()) {
    o.amount = o.maxAmount;
    o.depleted = false;
    o.respawnAt = 0;
  }
  for (const p of room.players.values()) {
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
    p.ammo = mag;
    p.maxAmmo = mag;
    p.alive = true;
    p.respawnAt = 0;
    p.slowedUntil = 0;
    p.shieldActiveUntil = 0;
    p.overclockUntil = 0;
    p.miningNodeId = null;
    p.oreFracBuffer = 0;
    p.lastGadgetAtMs = 0;
    p.lastClassSkillAtMs = 0;
    p.lastMoveCheckAtMs = now;
    p.kills = 0;
    p.deaths = 0;
    p.assists = 0;
    p.damageDealt = 0;
    p.oreMined = 0;
    p.shotsFiredMatch = 0;
    p.shotsHitMatch = 0;
    p.hazardKillsMatch = 0;
    p.barriersDestroyedMatch = 0;
  }
  broadcastToRoom(room, 'room:reset', { snapshot: serializeRoomSnapshot(room) });
}

function finishMatch(room: ServerRoom): void {
  if (room.matchFinalized) return;
  room.phase = 'ended';
  room.matchFinalized = true;

  const participants = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    callsign: p.callsign,
    team: p.team,
    kills: p.kills,
    deaths: p.deaths,
    damageDealt: p.damageDealt,
    mmr: p.isBot ? 1250 : (store.profiles[p.id]?.stats.mmr ?? 1250),
  }));

  const outcome = evaluateMatchOutcome(room.config.mode, room.scoreCobalt, room.scoreAmber, participants);

  for (const p of room.players.values()) {
    if (p.isBot) continue;
    const profile = store.profiles[p.id];
    if (!profile) continue;

    const won = room.config.mode === 'ffa' ? outcome.winnerId === p.id : p.team === outcome.winningTeam;
    const kd = p.kills / Math.max(1, p.deaths);
    const oppMmr =
      room.config.mode === 'ffa'
        ? outcome.avgRoomMmr
        : p.team === 'cobalt'
          ? outcome.avgAmberMmr
          : outcome.avgCobaltMmr;
    const mmrDelta = calculateMmrDelta(profile.stats.mmr, oppMmr, won, kd);
    const xpEarned = 80 + p.kills * 18 + (won ? 65 : 20);
    const accuracy = p.shotsFiredMatch > 0 ? Math.round((p.shotsHitMatch / p.shotsFiredMatch) * 100) : 0;

    profile.stats.matchesPlayed += 1;
    if (won) profile.stats.wins += 1;
    else profile.stats.losses += 1;
    profile.stats.kills += p.kills;
    profile.stats.deaths += p.deaths;
    profile.stats.assists += p.assists;
    profile.stats.shotsFired += p.shotsFiredMatch;
    profile.stats.shotsHit += p.shotsHitMatch;
    profile.stats.damageDealt += Math.round(p.damageDealt);
    profile.stats.hazardKills += p.hazardKillsMatch;
    profile.stats.barriersDestroyed += p.barriersDestroyedMatch;
    profile.stats.mmr = Math.max(400, profile.stats.mmr + mmrDelta);
    profile.stats.xp += xpEarned;
    profile.stats.credits += Math.round(xpEarned * 0.75);

    if (!profile.stats.weaponStats[p.weaponId]) {
      profile.stats.weaponStats[p.weaponId] = { kills: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0 };
    }
    const wStat = profile.stats.weaponStats[p.weaponId];
    if (wStat) {
      wStat.kills += p.kills;
      wStat.shotsFired += p.shotsFiredMatch;
      wStat.shotsHit += p.shotsHitMatch;
      wStat.damageDealt += Math.round(p.damageDealt);
    }

    profile.stats.recentMatches.unshift({
      id: `m_${Date.now()}_${p.id.slice(-3)}`,
      timestamp: Date.now(),
      mapId: room.config.mapId,
      mode: room.config.mode,
      won,
      kills: p.kills,
      deaths: p.deaths,
      accuracy,
      mmrDelta,
      xpEarned,
    });
    profile.stats.recentMatches = profile.stats.recentMatches.slice(0, 10);

    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(
        JSON.stringify({
          type: 'match:summary',
          payload: {
            won,
            mode: room.config.mode,
            winningTeam: outcome.winningTeam,
            winnerName: outcome.winnerName,
            placement: outcome.placements.get(p.id) ?? 1,
            kills: p.kills,
            deaths: p.deaths,
            accuracy,
            mmrDelta,
            newMmr: profile.stats.mmr,
            xpEarned,
            newXp: profile.stats.xp,
            scoreCobalt: Math.round(room.scoreCobalt),
            scoreAmber: Math.round(room.scoreAmber),
          },
        }),
      );
    }
  }
  saveStore();

  if (room.resetTimer) clearTimeout(room.resetTimer);
  room.resetTimer = setTimeout(() => {
    resetRoomForNewMatch(room);
  }, 8000);
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

// 20Hz Authoritative Simulation Loop
const TICK_MS = 50;
setInterval(() => {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  for (const room of rooms.values()) {
    const hasHumans = Array.from(room.players.values()).some((p) => !p.isBot && p.ws);
    if (!hasHumans) {
      if (!DEFAULT_PUBLIC_ROOM_IDS.has(room.config.roomId) && now - room.lastHumanAtMs > 60_000) {
        if (room.resetTimer) clearTimeout(room.resetTimer);
        rooms.delete(room.config.roomId);
      } else {
        room.startedAtMs = now;
      }
      continue;
    }

    room.lastHumanAtMs = now;
    const map = MAPS[room.config.mapId];
    const elapsedSec = (now - room.startedAtMs) / 1000;

    if (room.phase === 'active' && elapsedSec >= room.durationSec) {
      finishMatch(room);
    }

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
        p.lastMoveCheckAtMs = now;
      }

      if (!p.alive) {
        p.miningNodeId = null;
        continue;
      }

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
        finishMatch(room);
      }
    }

    // Broadcast authoritative snapshot to connected human clients
    broadcastToRoom(room, 'match:state', serializeRoomSnapshot(room));
  }

  // Run SBMM Matchmaker tick grouped by requested mode
  if (matchmakingQueue.size >= 2) {
    const byMode = new Map<GameModeId, Array<{ candidate: QueueCandidate; mode: GameModeId; mapId: MapId; ws: WebSocket }>>();
    for (const entry of matchmakingQueue.values()) {
      const list = byMode.get(entry.mode) || [];
      list.push(entry);
      byMode.set(entry.mode, list);
    }
    for (const [mode, entries] of byMode.entries()) {
      if (entries.length < 2) continue;
      const matched = formBalancedMatch(
        entries.map((e) => e.candidate),
        now,
        4,
      );
      if (matched) {
        const anchorEntry = entries.find((e) => e.candidate.playerId === matched.cobalt[0]?.playerId) || entries[0];
        const room = createRoom({
          name: `Ranked ${mode === 'ffa' ? 'FFA' : mode === 'control_core' ? 'Core' : '3v3'} Match`,
          mapId: anchorEntry.mapId,
          mode,
          isPrivate: false,
        });
        const assignPlayer = (c: QueueCandidate, team: TeamId) => {
          const q = matchmakingQueue.get(c.playerId);
          if (!q) return;
          matchmakingQueue.delete(c.playerId);
          joinSocketToRoom(q.ws, q.candidate.playerId, room.config.roomId, team);
          q.ws.send(JSON.stringify({ type: 'mmq:matched', payload: { roomId: room.config.roomId, team } }));
        };
        matched.cobalt.forEach((c) => assignPlayer(c, 'cobalt'));
        matched.amber.forEach((c) => assignPlayer(c, 'amber'));
      }
    }
  }

  // Fallback deployment if a solo queued player waited > 2.5s
  for (const [pid, entry] of matchmakingQueue.entries()) {
    if (now - entry.candidate.queuedAtMs > 2500) {
      matchmakingQueue.delete(pid);
      let targetRoomId: string;
      if (entry.mode === 'ffa') {
        targetRoomId = entry.mapId === 'reactor_foundry' ? 'PUBLIC-FFA' : createRoom({
          name: 'Ranked FFA · Cryo Relay',
          mapId: entry.mapId,
          mode: 'ffa',
          isPrivate: false,
        }).config.roomId;
      } else if (entry.mode === 'control_core') {
        targetRoomId = entry.mapId === 'cryo_relay' ? 'PUBLIC-CRYO' : createRoom({
          name: 'Ranked Core · Reactor Foundry',
          mapId: entry.mapId,
          mode: 'control_core',
          isPrivate: false,
        }).config.roomId;
      } else {
        targetRoomId = entry.mapId === 'reactor_foundry' ? 'PUBLIC-ALPHA' : createRoom({
          name: 'Ranked 3v3 · Cryo Relay',
          mapId: entry.mapId,
          mode: 'team_clash',
          isPrivate: false,
        }).config.roomId;
      }
      joinSocketToRoom(entry.ws, pid, targetRoomId);
      entry.ws.send(JSON.stringify({ type: 'mmq:matched', payload: { roomId: targetRoomId } }));
    }
  }
}, TICK_MS);

function joinSocketToRoom(ws: WebSocket, playerId: string, roomId: string, forcedTeam?: TeamId): void {
  const clientMeta = clientSockets.get(ws);
  if (!clientMeta) return;

  // Leave previous room
  if (clientMeta.roomId && rooms.has(clientMeta.roomId)) {
    const oldRoom = rooms.get(clientMeta.roomId)!;
    const existing = oldRoom.players.get(playerId);
    if (!existing || existing.ws === ws) {
      oldRoom.players.delete(playerId);
    }
    ensureRoomBots(oldRoom);
  }

  const room = rooms.get(roomId) || rooms.get('PUBLIC-ALPHA')!;
  const existingHumans = Array.from(room.players.values()).filter((p) => !p.isBot && p.id !== playerId);
  if (room.phase === 'ended' && existingHumans.length === 0) {
    resetRoomForNewMatch(room);
  }
  if (existingHumans.length === 0) {
    room.startedAtMs = Date.now();
  }
  room.lastHumanAtMs = Date.now();

  const profile = getOrCreateProfile(playerId);
  const safeLoadout = sanitizeLoadoutForXp(profile.loadout, DEFAULT_LOADOUT, profile.stats.xp);
  profile.loadout = safeLoadout;

  const cobaltMmrs = Array.from(room.players.values())
    .filter((p) => p.team === 'cobalt' && !p.isBot)
    .map((p) => store.profiles[p.id]?.stats.mmr ?? 1250);
  const amberMmrs = Array.from(room.players.values())
    .filter((p) => p.team === 'amber' && !p.isBot)
    .map((p) => store.profiles[p.id]?.stats.mmr ?? 1250);

  const team: TeamId = forcedTeam || pickBalancedTeamForJoiner(cobaltMmrs, amberMmrs);
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
    lastMoveCheckAtMs: Date.now(),
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
    ws,
  };

  room.players.set(playerId, combatant);
  clientMeta.roomId = room.config.roomId;
  ensureRoomBots(room);

  ws.send(
    JSON.stringify({
      type: 'room:joined',
      payload: {
        roomId: room.config.roomId,
        playerId,
        team,
        snapshot: serializeRoomSnapshot(room),
      },
    }),
  );
}

// =============================================================================
// Express HTTP & WebSocket Server Setup
// =============================================================================

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.size, timestamp: Date.now() });
  });

  app.get('/api/profile/:id', (req, res) => {
    const profile = getOrCreateProfile(req.params.id);
    res.json(profile);
  });

  app.post('/api/profile', (req, res) => {
    const body = req.body as Partial<PlayerProfile> & { id?: string };
    if (!body?.id || typeof body.id !== 'string') {
      res.status(400).json({ error: 'Profile id is required' });
      return;
    }
    const existing = getOrCreateProfile(body.id, body.callsign);
    if (typeof body.callsign === 'string' && body.callsign.trim().length >= 2) {
      existing.callsign = body.callsign.trim().slice(0, 18);
    }
    if (body.platform === 'pc' || body.platform === 'console' || body.platform === 'cloud') {
      existing.platform = body.platform;
    }
    if (typeof body.crossplayEnabled === 'boolean') existing.crossplayEnabled = body.crossplayEnabled;
    if (body.loadout) {
      existing.loadout = sanitizeLoadoutForXp(body.loadout, existing.loadout, existing.stats.xp);
    }
    if (body.controller) {
      const c = body.controller;
      const cur = normalizeControllerConfig(existing.controller);
      const crosshairStyle =
        c.crosshairStyle === 'precision' || c.crosshairStyle === 'chevron' || c.crosshairStyle === 'ring'
          ? c.crosshairStyle
          : cur.crosshairStyle;
      const nextBindings = { ...DEFAULT_CONTROLLER.bindings, ...cur.bindings };
      if (c.bindings && typeof c.bindings === 'object') {
        for (const k of Object.keys(DEFAULT_CONTROLLER.bindings) as Array<keyof typeof DEFAULT_CONTROLLER.bindings>) {
          if (typeof c.bindings[k] === 'string' && c.bindings[k].trim()) {
            nextBindings[k] = c.bindings[k].trim().slice(0, 24);
          }
        }
      }
      existing.controller = normalizeControllerConfig({
        mouseSensitivity: clampNum(c.mouseSensitivity, 0.2, 3.0, cur.mouseSensitivity),
        adsMultiplier: clampNum(c.adsMultiplier, 0.2, 1.5, cur.adsMultiplier),
        fov: Math.round(clampNum(c.fov, 65, 105, cur.fov)),
        invertY: typeof c.invertY === 'boolean' ? c.invertY : cur.invertY,
        crosshairStyle,
        gamepadEnabled: typeof c.gamepadEnabled === 'boolean' ? c.gamepadEnabled : cur.gamepadEnabled,
        leftStickDeadzone: clampNum(c.leftStickDeadzone, 0.02, 0.45, cur.leftStickDeadzone),
        rightStickDeadzone: clampNum(c.rightStickDeadzone, 0.02, 0.45, cur.rightStickDeadzone),
        gamepadSensitivity: clampNum(c.gamepadSensitivity, 0.5, 6.0, cur.gamepadSensitivity),
        triggerThreshold: clampNum(c.triggerThreshold, 0.05, 0.9, cur.triggerThreshold),
        vibrationEnabled: typeof c.vibrationEnabled === 'boolean' ? c.vibrationEnabled : cur.vibrationEnabled,
        bindings: nextBindings,
      });
    }
    saveStore();

    // Update live player in active room if connected
    for (const room of rooms.values()) {
      const p = room.players.get(existing.id);
      if (p) {
        p.callsign = existing.callsign;
        p.platform = existing.platform;
        const prevClass = p.robotClass;
        p.robotClass = existing.loadout.robotClass;
        p.weaponId = existing.loadout.weaponId;
        p.beamHex = COSMETICS.find((c) => c.id === existing.loadout.beamColorId)?.hex || p.beamHex;
        p.skinHex = COSMETICS.find((c) => c.id === existing.loadout.skinId)?.hex || p.skinHex;
        const classSpec = ROBOT_CLASSES[p.robotClass] || ROBOT_CLASSES.s1_striker;
        const mag = getInitialAmmoForClass(p.robotClass, p.weaponId);
        p.maxHp = classSpec.maxHp;
        p.maxShield = classSpec.maxShield;
        p.maxAmmo = mag;
        if (prevClass !== p.robotClass) {
          p.hp = Math.min(p.maxHp, p.hp);
          p.shield = Math.min(p.maxShield, p.shield);
          if (!canRobotClassFire(p.robotClass)) {
            if (canRobotClassFire(prevClass)) {
              p.stashedCombatAmmo = p.ammo;
            }
            p.ammo = 0;
          } else {
            p.ammo = Math.min(mag, p.stashedCombatAmmo ?? mag);
          }
        }
      }
    }

    res.json(existing);
  });

  app.get('/api/friends/:id', (req, res) => {
    getOrCreateProfile(req.params.id);
    res.json({ friends: store.friends[req.params.id] || [] });
  });

  app.post('/api/friends/add', (req, res) => {
    const { playerId, callsign } = req.body as { playerId?: string; callsign?: string };
    if (!playerId || !callsign || !callsign.trim()) {
      res.status(400).json({ error: 'Valid callsign required' });
      return;
    }
    getOrCreateProfile(playerId);
    const list = store.friends[playerId] || [];
    const trimmed = callsign.trim().slice(0, 18);
    if (list.some((f) => f.callsign.toLowerCase() === trimmed.toLowerCase())) {
      res.json({ friends: list, added: false });
      return;
    }
    const newFriend: FriendEntry = {
      id: `fr_${Date.now().toString(36)}`,
      callsign: trimmed,
      platform: 'pc',
      status: 'online',
      mmr: 1200 + Math.floor(Math.random() * 250),
    };
    list.unshift(newFriend);
    store.friends[playerId] = list;
    saveStore();
    res.json({ friends: list, added: true });
  });

  app.get('/api/lobbies', (_req, res) => {
    const list = Array.from(rooms.values())
      .filter((r) => !r.config.isPrivate)
      .map((r) => r.config);
    res.json({ lobbies: list, queueSize: matchmakingQueue.size });
  });

  app.post('/api/lobbies/create', (req, res) => {
    const body = req.body as Partial<LobbyConfig>;
    const room = createRoom({
      name: body.name || 'Private Tactical Lobby',
      hostId: body.hostId || 'host',
      hostCallsign: body.hostCallsign || 'Host',
      isPrivate: body.isPrivate ?? true,
      mapId: body.mapId || 'reactor_foundry',
      mode: body.mode || 'team_clash',
      maxPlayers: body.maxPlayers || 8,
      hazardIntensity: body.hazardIntensity || 'standard',
      friendlyFire: Boolean(body.friendlyFire),
      crossplayPool: body.crossplayPool ?? true,
    });
    res.json({ lobby: room.config });
  });

  app.post('/api/lobbies/join', (req, res) => {
    const { roomId } = req.body as { roomId?: string };
    const normalized = (roomId || '').trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) {
      res.status(404).json({ error: 'Lobby code not found' });
      return;
    }
    res.json({ lobby: room.config });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const defaultId = `plr_${Math.random().toString(36).slice(2, 8)}`;
    clientSockets.set(ws, { playerId: defaultId, roomId: null });

    ws.on('message', (raw) => {
      let msg: { type: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const meta = clientSockets.get(ws);
      if (!meta) return;

      const payload = msg.payload || {};

      switch (msg.type) {
        case 'auth:hello': {
          const pid =
            typeof payload.playerId === 'string' && payload.playerId.trim()
              ? payload.playerId.trim().slice(0, 48)
              : meta.playerId;
          if (pid !== meta.playerId && meta.roomId && rooms.has(meta.roomId)) {
            const oldRoom = rooms.get(meta.roomId)!;
            const oldCombatant = oldRoom.players.get(meta.playerId);
            if (oldCombatant && oldCombatant.ws === ws) {
              oldRoom.players.delete(meta.playerId);
              oldCombatant.id = pid;
              oldRoom.players.set(pid, oldCombatant);
            }
          }
          meta.playerId = pid;
          getOrCreateProfile(pid, typeof payload.callsign === 'string' ? payload.callsign : undefined);
          ws.send(JSON.stringify({ type: 'auth:ack', payload: { playerId: pid } }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', payload: { clientTime: payload.clientTime, serverTime: Date.now() } }));
          break;
        }

        case 'room:join': {
          const roomId = typeof payload.roomId === 'string' ? payload.roomId : 'PUBLIC-ALPHA';
          joinSocketToRoom(ws, meta.playerId, roomId);
          break;
        }

        case 'room:rematch': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room) return;
          if (room.phase === 'ended') {
            resetRoomForNewMatch(room);
          } else {
            const p = room.players.get(meta.playerId);
            if (p) {
              ws.send(JSON.stringify({ type: 'room:reset', payload: { snapshot: serializeRoomSnapshot(room) } }));
            }
          }
          break;
        }

        case 'mmq:join': {
          const profile = getOrCreateProfile(meta.playerId);
          const mode: GameModeId =
            payload.mode === 'ffa' || payload.mode === 'control_core' || payload.mode === 'team_clash'
              ? payload.mode
              : 'team_clash';
          const mapId: MapId =
            typeof payload.mapId === 'string' && payload.mapId in MAPS
              ? (payload.mapId as MapId)
              : 'reactor_foundry';
          matchmakingQueue.set(meta.playerId, {
            candidate: {
              playerId: meta.playerId,
              callsign: profile.callsign,
              mmr: profile.stats.mmr,
              platform: profile.platform,
              crossplayEnabled: profile.crossplayEnabled,
              queuedAtMs: Date.now(),
            },
            mode,
            mapId,
            ws,
          });
          ws.send(JSON.stringify({ type: 'mmq:status', payload: { queued: true, poolSize: matchmakingQueue.size } }));
          break;
        }

        case 'mmq:leave': {
          matchmakingQueue.delete(meta.playerId);
          ws.send(JSON.stringify({ type: 'mmq:status', payload: { queued: false, poolSize: matchmakingQueue.size } }));
          break;
        }

        case 'player:move': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room) return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          const now = Date.now();
          const dtSec = Math.max(0.016, (now - p.lastMoveCheckAtMs) / 1000);
          p.lastMoveCheckAtMs = now;
          const map = MAPS[room.config.mapId];

          const nextPos: Vec3 = {
            x: toFinite(payload.x, Number.NaN),
            y: toFinite(payload.y, Number.NaN),
            z: toFinite(payload.z, Number.NaN),
          };
          const dashing = Boolean(payload.dashing);
          const check = validateMovementDelta(
            { x: p.x, y: p.y, z: p.z },
            nextPos,
            dtSec,
            dashing,
            p.slowedUntil > now,
            map.halfSize,
          );

          room.antiCheat.packetsValidated += 1;
          room.antiCheat.lastCheckAt = now;
          if (!check.valid) {
            room.antiCheat.movementCorrections += 1;
            ws.send(JSON.stringify({ type: 'anticheat:correct', payload: check.correctedPos }));
          }

          p.x = check.correctedPos.x;
          p.y = check.correctedPos.y;
          p.z = check.correctedPos.z;
          // Enforce server-side robot body separation if overlapping another combatant
          const minBodySep = PLAYER_RADIUS * 1.75;
          const bound = map.halfSize - PLAYER_RADIUS - 0.3;
          for (const other of room.players.values()) {
            if (!other.alive || other.id === p.id) continue;
            if (Math.abs(other.y - p.y) >= PLAYER_HEIGHT - 0.05) continue;
            const dx = p.x - other.x;
            const dz = p.z - other.z;
            const d = Math.hypot(dx, dz);
            if (d < minBodySep) {
              const nx = d > 1e-4 ? dx / d : 1;
              const nz = d > 1e-4 ? dz / d : 0;
              p.x = Math.max(-bound, Math.min(bound, other.x + nx * minBodySep));
              p.z = Math.max(-bound, Math.min(bound, other.z + nz * minBodySep));
            }
          }
          p.yaw = toFinite(payload.yaw, p.yaw);
          p.chassisYaw = toFinite(payload.chassisYaw, p.yaw);
          p.pitch = clampNum(payload.pitch, -1.5, 1.5, p.pitch);
          p.vx = clampNum(payload.vx, -30, 30, 0);
          p.vy = clampNum(payload.vy, -30, 30, 0);
          p.vz = clampNum(payload.vz, -30, 30, 0);
          p.dashing = dashing;
          break;
        }

        case 'player:buy_ammo': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room || room.phase !== 'active') return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          const packId = String(payload.packId || 'full_mag') as AmmoPackId;
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
            ws.send(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: check.reason } }));
            return;
          }

          const pack = AMMO_PACKS[packId];
          addTeamCredits(room, p.team, -pack.cost);
          p.ammo = pack.fullFill ? p.maxAmmo : Math.min(p.maxAmmo, p.ammo + pack.ammoGrant);
          if (pack.healHull > 0) p.hp = Math.min(p.maxHp, p.hp + pack.healHull);
          if (pack.healShield > 0) p.shield = Math.min(p.maxShield, p.shield + pack.healShield);
          if (packId === 'overcharge_cell') {
            p.overclockUntil = Date.now() + 5500;
          }
          ws.send(
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
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room || room.phase !== 'active') return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          const now = Date.now();
          const dtMine = Math.min(0.3, Math.max(0.05, (now - p.lastMineAtMs) / 1000));
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
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room || room.phase !== 'active') return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          const now = Date.now();
          const classSpec = ROBOT_CLASSES[p.robotClass];
          const cd = validateGadgetCooldown(p.lastClassSkillAtMs, now, classSpec.classSkillCooldownSec);
          if (!cd.allowed) {
            room.antiCheat.rateLimitBlocks += 1;
            return;
          }
          p.lastClassSkillAtMs = now;
          p.overclockUntil = now + 5000;

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
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room || room.phase !== 'active') return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          const gadgetId = String(payload.gadgetId || '');
          if (!(gadgetId in GADGETS)) return;
          const spec = GADGETS[gadgetId as keyof typeof GADGETS];
          const profile = getOrCreateProfile(meta.playerId);
          if (profile.stats.xp < spec.unlockXp) {
            room.antiCheat.rateLimitBlocks += 1;
            return;
          }

          const now = Date.now();
          const cd = validateGadgetCooldown(p.lastGadgetAtMs, now, spec.cooldownSec);
          if (!cd.allowed) {
            room.antiCheat.rateLimitBlocks += 1;
            return;
          }
          p.lastGadgetAtMs = now;

          if (gadgetId === 'aegis_wall') {
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
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room || room.phase !== 'active') return;
          const p = room.players.get(meta.playerId);
          if (!p || !p.alive) return;

          if (!canRobotClassFire(p.robotClass)) {
            ws.send(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: 'ep_no_weapon' } }));
            return;
          }

          if (p.ammo <= 0) {
            ws.send(JSON.stringify({ type: 'economy:notice', payload: { ok: false, reason: 'no_ammo' } }));
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

          const originCheck = validateFireOriginAndDir(
            { x: p.x, y: p.y, z: p.z },
            PLAYER_EYE_HEIGHT,
            payload.origin as Vec3 | undefined,
            payload.dir as Vec3 | undefined,
          );
          if (!originCheck.valid) {
            room.antiCheat.losRejections += 1;
            return;
          }

          p.lastShotAtMs = now;
          p.ammo = Math.max(0, p.ammo - 1);
          p.shotsFiredMatch += 1;

          const origin = originCheck.origin;
          const baseDir = originCheck.dir;
          const map = MAPS[room.config.mapId];
          const colliders = getArenaActiveColliders(map, Array.from(room.barriers.values()));

          const pelletCount = Math.max(1, weapon.pellets);
          const damageByTarget = new Map<ServerCombatant, number>();
          let anyTargetHit = false;
          let primaryEndPos: Vec3 | null = null;

          for (let pellet = 0; pellet < pelletCount; pellet++) {
            let dir = baseDir;
            if (pellet > 0) {
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
              ws.send(
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

        case 'voice:speaking': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          const p = room?.players.get(meta.playerId);
          if (p) p.speaking = Boolean(payload.speaking);
          break;
        }

        case 'rtc:offer':
        case 'rtc:answer':
        case 'rtc:ice': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room) return;
          const targetId = String(payload.targetId || '');
          const target = room.players.get(targetId);
          if (target?.ws && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(
              JSON.stringify({
                type: msg.type,
                payload: { ...payload, fromId: meta.playerId },
              }),
            );
          }
          break;
        }

        case 'chat:send': {
          if (!meta.roomId) return;
          const room = rooms.get(meta.roomId);
          if (!room) return;
          const p = room.players.get(meta.playerId);
          const text = String(payload.text || '').trim().slice(0, 140);
          if (!p || !text) return;
          broadcastToRoom(room, 'chat:msg', {
            id: `c_${Date.now()}`,
            sender: p.callsign,
            team: p.team,
            text,
            timestamp: Date.now(),
          });
          break;
        }
      }
    });

    ws.on('close', () => {
      const meta = clientSockets.get(ws);
      if (meta) {
        const queued = matchmakingQueue.get(meta.playerId);
        if (queued && queued.ws === ws) {
          matchmakingQueue.delete(meta.playerId);
        }
        if (meta.roomId && rooms.has(meta.roomId)) {
          const room = rooms.get(meta.roomId)!;
          const existing = room.players.get(meta.playerId);
          if (existing && existing.ws === ws) {
            room.players.delete(meta.playerId);
            ensureRoomBots(room);
          }
        }
        clientSockets.delete(ws);
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Prism Breach server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server boot error:', err);
  process.exit(1);
});
