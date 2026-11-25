import { MAPS, ROBOT_CLASSES, WEAPONS } from './catalog.ts';
import type {
  AntiCheatAudit,
  CombatantSnapshot,
  DestructibleBarrierState,
  HazardRuntimeState,
  KillFeedEvent,
  MapId,
  MatchSnapshot,
  OreNodeState,
  PlatformType,
  RobotClass,
  TeamId,
  WeaponId,
} from './types.ts';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface CompactBarrierState {
  id: string;
  hp: number;
  destroyed: boolean;
  respawnAt?: number;
}

export interface CompactOreNodeState {
  id: string;
  amount: number;
  depleted: boolean;
  respawnAt?: number;
}

export interface CompactHazardState {
  id: string;
  phase: HazardRuntimeState['phase'];
  progress?: number;
  sweepAngle?: number;
}

export interface CompactCombatantSnapshot {
  id: string;
  isBot: boolean;
  robotClass: RobotClass;
  team: TeamId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  chassisYaw: number;
  pitch: number;
  vx: number;
  vy?: number;
  vz: number;
  hp: number;
  shield: number;
  ammo: number;
  alive: boolean;
  weaponId: WeaponId;
  callsign?: string;
  platform?: PlatformType;
  botPolicy?: CombatantSnapshot['botPolicy'];
  beamHex?: string;
  skinHex?: string;
  maxHp?: number;
  maxShield?: number;
  maxAmmo?: number;
  respawnAt?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  damageDealt?: number;
  oreMined?: number;
  dashing?: boolean;
  shieldActive?: boolean;
  overclocked?: boolean;
  miningNodeId?: string | null;
  slowedUntil?: number;
  speaking?: boolean;
  lastProcessedInputSeq?: number;
  grounded?: boolean;
  dashCooldown?: number;
  dashRemaining?: number;
  heat?: number;
  overheated?: boolean;
  gadgetCooldown?: number;
  classSkillCooldown?: number;
}

export interface CompactMatchSnapshot {
  compact: 1;
  roomId: string;
  matchId?: string;
  serverTick?: number;
  serverTimeMs?: number;
  isPrivate?: boolean;
  mapId: MapId;
  mode: MatchSnapshot['mode'];
  phase: MatchSnapshot['phase'];
  elapsedSec: number;
  durationSec?: number;
  scoreCobalt: number;
  scoreAmber: number;
  scoreLimit?: number;
  teamCreditsCobalt: number;
  teamCreditsAmber: number;
  controlOwner: MatchSnapshot['controlOwner'];
  controlProgress: number;
  players: CompactCombatantSnapshot[];
  barriers: CompactBarrierState[];
  hazards: CompactHazardState[];
  oreNodes: CompactOreNodeState[];
  killFeed?: KillFeedEvent[];
  antiCheat?: AntiCheatAudit;
}

export interface SnapshotEncodeOptions {
  includeRosterMeta?: boolean;
  includeKillFeed?: boolean;
  includeAntiCheat?: boolean;
}

/**
 * Strips static map geometry (ore positions/tiers, barrier maxHp, hazard kinds),
 * unchanging roster metadata, default-zero flags, and excess float digits from
 * 20 Hz match:state snapshots while keeping core protocol fields directly readable.
 */
export function encodeCompactMatchSnapshot(
  full: MatchSnapshot,
  options: SnapshotEncodeOptions = {},
): CompactMatchSnapshot {
  const includeRosterMeta = options.includeRosterMeta ?? false;
  const includeKillFeed = options.includeKillFeed ?? true;
  const includeAntiCheat = options.includeAntiCheat ?? false;

  const players: CompactCombatantSnapshot[] = full.players.map(p => {
    const out: CompactCombatantSnapshot = {
      id: p.id,
      isBot: p.isBot,
      robotClass: p.robotClass,
      team: p.team,
      x: round2(p.x),
      y: round2(p.y),
      z: round2(p.z),
      yaw: round3(p.yaw),
      chassisYaw: round3(p.chassisYaw),
      pitch: round3(p.pitch),
      vx: round2(p.vx),
      vz: round2(p.vz),
      hp: Math.round(p.hp),
      shield: Math.round(p.shield),
      ammo: Math.max(0, Math.round(p.ammo)),
      alive: p.alive,
      weaponId: p.weaponId,
    };
    const vy = round2(p.vy);
    if (vy !== 0) out.vy = vy;
    if (includeRosterMeta) {
      out.callsign = p.callsign;
      out.platform = p.platform;
      out.beamHex = p.beamHex;
      out.skinHex = p.skinHex;
      if (p.botPolicy) out.botPolicy = p.botPolicy;
    }
    if (p.respawnAt > 0) out.respawnAt = p.respawnAt;
    if (p.kills > 0) out.kills = p.kills;
    if (p.deaths > 0) out.deaths = p.deaths;
    if (p.assists > 0) out.assists = p.assists;
    if (p.damageDealt > 0) out.damageDealt = Math.round(p.damageDealt);
    if (p.oreMined > 0) out.oreMined = Math.round(p.oreMined);
    if (p.dashing) out.dashing = true;
    if (p.shieldActive) out.shieldActive = true;
    if (p.overclocked) out.overclocked = true;
    if (p.miningNodeId) out.miningNodeId = p.miningNodeId;
    if (p.slowedUntil > 0) out.slowedUntil = p.slowedUntil;
    if (p.speaking) out.speaking = true;
    if (!p.isBot) {
      if (p.lastProcessedInputSeq !== undefined) out.lastProcessedInputSeq = p.lastProcessedInputSeq;
      if (p.grounded === false) out.grounded = false;
      const dc = round2(p.dashCooldown ?? 0);
      if (dc > 0) out.dashCooldown = dc;
      const dr = round2(p.dashRemaining ?? 0);
      if (dr > 0) out.dashRemaining = dr;
      const heat = round2(p.heat ?? 0);
      if (heat > 0) out.heat = heat;
      if (p.overheated) out.overheated = true;
      const gc = round2(p.gadgetCooldown ?? 0);
      if (gc > 0) out.gadgetCooldown = gc;
      const csc = round2(p.classSkillCooldown ?? 0);
      if (csc > 0) out.classSkillCooldown = csc;
    }
    return out;
  });

  const barriers: CompactBarrierState[] = full.barriers.map(b => ({
    id: b.id,
    hp: Math.round(b.hp),
    destroyed: b.destroyed,
    ...(b.respawnAt > 0 ? { respawnAt: b.respawnAt } : {}),
  }));

  const hazards: CompactHazardState[] = full.hazards.map(h => {
    const out: CompactHazardState = { id: h.id, phase: h.phase };
    if (h.phase !== 'idle') out.progress = round2(h.progress);
    if (h.kind === 'laser_sweeper' && h.phase !== 'idle') out.sweepAngle = round3(h.sweepAngle);
    return out;
  });

  const oreNodes: CompactOreNodeState[] = full.oreNodes.map(o => ({
    id: o.id,
    amount: Math.round(o.amount),
    depleted: o.depleted,
    ...(o.respawnAt > 0 ? { respawnAt: o.respawnAt } : {}),
  }));

  return {
    compact: 1,
    roomId: full.roomId,
    ...(full.matchId ? { matchId: full.matchId } : {}),
    ...(full.serverTick !== undefined ? { serverTick: full.serverTick } : {}),
    ...(full.serverTimeMs !== undefined ? { serverTimeMs: full.serverTimeMs } : {}),
    ...(includeRosterMeta && full.isPrivate !== undefined ? { isPrivate: full.isPrivate } : {}),
    mapId: full.mapId,
    mode: full.mode,
    phase: full.phase,
    elapsedSec: round2(full.elapsedSec),
    ...(includeRosterMeta ? { durationSec: full.durationSec, scoreLimit: full.scoreLimit } : {}),
    scoreCobalt: Math.round(full.scoreCobalt),
    scoreAmber: Math.round(full.scoreAmber),
    teamCreditsCobalt: Math.round(full.teamCreditsCobalt),
    teamCreditsAmber: Math.round(full.teamCreditsAmber),
    controlOwner: full.controlOwner,
    controlProgress: round2(full.controlProgress),
    players,
    barriers,
    hazards,
    oreNodes,
    ...(includeKillFeed ? { killFeed: full.killFeed } : {}),
    ...(includeAntiCheat ? { antiCheat: full.antiCheat } : {}),
  };
}

interface RosterCacheEntry {
  callsign: string;
  platform: PlatformType;
  beamHex: string;
  skinHex: string;
  botPolicy?: CombatantSnapshot['botPolicy'];
}

const DEFAULT_ANTICHEAT: AntiCheatAudit = {
  packetsValidated: 0,
  movementCorrections: 0,
  rateLimitBlocks: 0,
  losRejections: 0,
  integrityStatus: 'verified',
  lastCheckAt: 0,
};

/**
 * Stateful client-side rehydrator that expands compact 20 Hz frames back into
 * full MatchSnapshot objects using static MAPS definitions and cached roster metadata.
 */
export class SnapshotRehydrator {
  private matchKey = '';
  private roster = new Map<string, RosterCacheEntry>();
  private isPrivate?: boolean;
  private durationSec = 240;
  private scoreLimit = 25;
  private killFeed: KillFeedEvent[] = [];
  private antiCheat: AntiCheatAudit = DEFAULT_ANTICHEAT;

  reset(): void {
    this.matchKey = '';
    this.roster.clear();
    this.isPrivate = undefined;
    this.durationSec = 240;
    this.scoreLimit = 25;
    this.killFeed = [];
    this.antiCheat = DEFAULT_ANTICHEAT;
  }

  hydrate(raw: MatchSnapshot | CompactMatchSnapshot): MatchSnapshot {
    const key = `${raw.roomId}:${raw.matchId ?? ''}`;
    if (key !== this.matchKey) {
      this.reset();
      this.matchKey = key;
    }

    if (raw.isPrivate !== undefined) this.isPrivate = raw.isPrivate;
    if (raw.durationSec !== undefined) this.durationSec = raw.durationSec;
    if (raw.scoreLimit !== undefined) this.scoreLimit = raw.scoreLimit;
    if (raw.killFeed !== undefined) this.killFeed = raw.killFeed;
    if (raw.antiCheat !== undefined) this.antiCheat = raw.antiCheat;

    const isCompact = 'compact' in raw && raw.compact === 1;
    if (!isCompact) {
      const full = raw as MatchSnapshot;
      for (const p of full.players) {
        this.roster.set(p.id, {
          callsign: p.callsign,
          platform: p.platform,
          beamHex: p.beamHex,
          skinHex: p.skinHex,
          botPolicy: p.botPolicy,
        });
      }
      return full;
    }

    const compact = raw as CompactMatchSnapshot;
    const map = MAPS[compact.mapId];
    const barrierDefs = new Map(map.barriers.map(b => [b.id, b]));
    const oreDefs = new Map(map.oreNodes.map(o => [o.id, o]));
    const hazardDefs = new Map(map.hazards.map(h => [h.id, h]));

    const players: CombatantSnapshot[] = compact.players.map(p => {
      const cached = this.roster.get(p.id);
      const nextMeta: RosterCacheEntry = {
        callsign: p.callsign ?? cached?.callsign ?? `Unit-${p.id.slice(-4).toUpperCase()}`,
        platform: p.platform ?? cached?.platform ?? 'pc',
        beamHex: p.beamHex ?? cached?.beamHex ?? (p.team === 'cobalt' ? '#06B6D4' : '#F59E0B'),
        skinHex: p.skinHex ?? cached?.skinHex ?? (p.team === 'cobalt' ? '#0E7490' : '#B45309'),
        botPolicy: p.botPolicy ?? cached?.botPolicy,
      };
      this.roster.set(p.id, nextMeta);

      const classSpec = ROBOT_CLASSES[p.robotClass];
      const maxAmmo = p.robotClass === 'ep_miner' ? 0 : (WEAPONS[p.weaponId]?.magSize ?? 30);

      return {
        id: p.id,
        callsign: nextMeta.callsign,
        isBot: p.isBot,
        ...(nextMeta.botPolicy ? { botPolicy: nextMeta.botPolicy } : {}),
        robotClass: p.robotClass,
        team: p.team,
        platform: nextMeta.platform,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        chassisYaw: p.chassisYaw,
        pitch: p.pitch,
        vx: p.vx,
        vy: p.vy ?? 0,
        vz: p.vz,
        hp: p.hp,
        maxHp: p.maxHp ?? classSpec.maxHp,
        shield: p.shield,
        maxShield: p.maxShield ?? classSpec.maxShield,
        ammo: p.ammo,
        maxAmmo: p.maxAmmo ?? maxAmmo,
        alive: p.alive,
        respawnAt: p.respawnAt ?? 0,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        assists: p.assists ?? 0,
        damageDealt: p.damageDealt ?? 0,
        oreMined: p.oreMined ?? 0,
        weaponId: p.weaponId,
        beamHex: nextMeta.beamHex,
        skinHex: nextMeta.skinHex,
        dashing: Boolean(p.dashing),
        shieldActive: Boolean(p.shieldActive),
        overclocked: Boolean(p.overclocked),
        miningNodeId: p.miningNodeId ?? null,
        slowedUntil: p.slowedUntil ?? 0,
        speaking: Boolean(p.speaking),
        ...(p.isBot
          ? {}
          : {
              lastProcessedInputSeq: p.lastProcessedInputSeq ?? 0,
              grounded: p.grounded ?? true,
              dashCooldown: p.dashCooldown ?? 0,
              dashRemaining: p.dashRemaining ?? 0,
              heat: p.heat ?? 0,
              overheated: Boolean(p.overheated),
              gadgetCooldown: p.gadgetCooldown ?? 0,
              classSkillCooldown: p.classSkillCooldown ?? 0,
            }),
      };
    });

    const barriers: DestructibleBarrierState[] = compact.barriers.map(b => ({
      id: b.id,
      hp: b.hp,
      maxHp: barrierDefs.get(b.id)?.maxHp ?? 130,
      destroyed: b.destroyed,
      respawnAt: b.respawnAt ?? 0,
    }));

    const hazards: HazardRuntimeState[] = compact.hazards.map(h => ({
      id: h.id,
      kind: hazardDefs.get(h.id)?.kind ?? 'plasma_pylon',
      phase: h.phase,
      progress: h.progress ?? 0,
      sweepAngle: h.sweepAngle ?? 0,
    }));

    const oreNodes: OreNodeState[] = compact.oreNodes.map(o => {
      const def = oreDefs.get(o.id);
      return {
        id: o.id,
        x: def?.x ?? 0,
        y: def?.y ?? 0,
        z: def?.z ?? 0,
        amount: o.amount,
        maxAmount: def?.maxAmount ?? 180,
        tier: def?.tier ?? 'standard',
        depleted: o.depleted,
        respawnAt: o.respawnAt ?? 0,
      };
    });

    return {
      roomId: compact.roomId,
      matchId: compact.matchId,
      serverTick: compact.serverTick,
      serverTimeMs: compact.serverTimeMs,
      isPrivate: this.isPrivate,
      mapId: compact.mapId,
      mode: compact.mode,
      phase: compact.phase,
      elapsedSec: compact.elapsedSec,
      durationSec: this.durationSec,
      scoreCobalt: compact.scoreCobalt,
      scoreAmber: compact.scoreAmber,
      scoreLimit: this.scoreLimit,
      teamCreditsCobalt: compact.teamCreditsCobalt,
      teamCreditsAmber: compact.teamCreditsAmber,
      controlOwner: compact.controlOwner,
      controlProgress: compact.controlProgress,
      players,
      barriers,
      hazards,
      oreNodes,
      killFeed: this.killFeed,
      antiCheat: this.antiCheat,
    };
  }
}
