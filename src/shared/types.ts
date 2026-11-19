export type PlatformType = 'pc' | 'console' | 'cloud';
export type TeamId = 'cobalt' | 'amber';
export type RobotClass = 's1_striker' | 'ep_miner';
export type GameModeId = 'team_clash' | 'ffa' | 'control_core';
export type MapId = 'reactor_foundry' | 'cryo_relay';
export type WeaponId = 'pulse_carbine' | 'prism_railgun' | 'scatter_projector';
export type GadgetId = 'phase_dash' | 'aegis_wall' | 'emp_pulse';
export type AmmoPackId = 'light_mag' | 'full_mag' | 'combat_resupply' | 'overcharge_cell';
export type VoiceChannel = 'team' | 'squad' | 'proximity' | 'muted';
export type VoiceInputMode = 'ptt' | 'open';
export type GamePhase = 'title' | 'playing' | 'paused' | 'gameover';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AabbCollider {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  destructible?: boolean;
  materialTag?:
    | 'wall'
    | 'pillar'
    | 'ramp'
    | 'platform'
    | 'barrier'
    | 'landmark'
    | 'ore'
    | 'hazard'
    | 'perimeter';
}

export interface RobotColliderPart {
  name: 'chassis' | 'turret' | 'arm_rig';
  localX: number;
  localY: number;
  localZ: number;
  w: number;
  h: number;
  d: number;
  useAimYaw: boolean;
}

export interface RobotColliderPose {
  id?: string;
  x: number;
  y: number;
  z: number;
  chassisYaw: number;
  aimYaw?: number;
  robotClass: RobotClass;
}

export interface DestructibleBarrierDef {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  maxHp: number;
}

export interface DestructibleBarrierState {
  id: string;
  hp: number;
  maxHp: number;
  destroyed: boolean;
  respawnAt: number;
}

export interface OreNodeDef {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
  maxAmount: number;
  tier: 'standard' | 'rich';
}

export interface OreNodeState {
  id: string;
  x: number;
  y: number;
  z: number;
  amount: number;
  maxAmount: number;
  tier: 'standard' | 'rich';
  depleted: boolean;
  respawnAt: number;
}

export type HazardKind = 'plasma_pylon' | 'coolant_leak' | 'laser_sweeper';
export type HazardPhase = 'idle' | 'telegraph' | 'active';

export interface HazardDef {
  id: string;
  kind: HazardKind;
  label: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  cycleSec: number;
  telegraphSec: number;
  activeSec: number;
  phaseOffsetSec: number;
  damagePerTick: number;
}

export interface HazardRuntimeState {
  id: string;
  kind: HazardKind;
  phase: HazardPhase;
  progress: number;
  sweepAngle: number;
}

export interface SpawnPoint {
  team: TeamId | 'neutral';
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface MapDefinition {
  id: MapId;
  name: string;
  subtitle: string;
  halfSize: number;
  fogColor: number;
  skyTopColor: number;
  skyBottomColor: number;
  keyLightColor: number;
  accentColor: string;
  controlCore: Vec3;
  spawns: SpawnPoint[];
  colliders: AabbCollider[];
  barriers: DestructibleBarrierDef[];
  hazards: HazardDef[];
  oreNodes: OreNodeDef[];
}

export interface RobotClassSpec {
  id: RobotClass;
  code: string;
  name: string;
  role: string;
  summary: string;
  maxHp: number;
  maxShield: number;
  speedMult: number;
  miningRatePerSec: number;
  classSkillName: string;
  classSkillDesc: string;
  classSkillCooldownSec: number;
}

export interface AmmoPackSpec {
  id: AmmoPackId;
  name: string;
  shortLabel: string;
  cost: number;
  ammoGrant: number; // 0 = fill to maxAmmo
  fullFill: boolean;
  healHull: number;
  healShield: number;
  resetHeat: boolean;
}

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  role: string;
  damage: number;
  fireIntervalMs: number;
  heatPerShot: number;
  coolRatePerSec: number;
  pellets: number;
  spreadRad: number;
  range: number;
  beamWidth: number;
  magSize: number;
  unlockXp: number;
}

export interface GadgetSpec {
  id: GadgetId;
  name: string;
  role: string;
  cooldownSec: number;
  unlockXp: number;
}

export interface CosmeticItem {
  id: string;
  category: 'beam' | 'skin' | 'emblem';
  name: string;
  hex: string;
  secondaryHex?: string;
  unlockXp: number;
}

export interface LoadoutConfig {
  robotClass: RobotClass;
  weaponId: WeaponId;
  gadgetId: GadgetId;
  beamColorId: string;
  skinId: string;
  emblemId: string;
}

export interface ControllerConfig {
  mouseSensitivity: number;
  adsMultiplier: number;
  fov: number;
  invertY: boolean;
  crosshairStyle: 'precision' | 'chevron' | 'ring';
  gamepadEnabled: boolean;
  leftStickDeadzone: number;
  rightStickDeadzone: number;
  gamepadSensitivity: number;
  triggerThreshold: number;
  vibrationEnabled: boolean;
  bindings: {
    fire: string;
    ads: string;
    dash: string;
    gadget: string;
    classSkill: string;
    buyAmmo: string;
    reload: string;
    voicePtt: string;
  };
}

export interface WeaponStats {
  kills: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
}

export interface MatchHistoryRecord {
  id: string;
  timestamp: number;
  mapId: MapId;
  mode: GameModeId;
  won: boolean;
  kills: number;
  deaths: number;
  accuracy: number;
  mmrDelta: number;
  xpEarned: number;
}

export interface PlayerCareerStats {
  matchesPlayed: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  assists: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  hazardKills: number;
  barriersDestroyed: number;
  oreMined?: number;
  mmr: number;
  xp: number;
  credits: number;
  weaponStats: Record<WeaponId, WeaponStats>;
  recentMatches: MatchHistoryRecord[];
}

export interface PlayerProfile {
  id: string;
  callsign: string;
  platform: PlatformType;
  crossplayEnabled: boolean;
  loadout: LoadoutConfig;
  controller: ControllerConfig;
  stats: PlayerCareerStats;
}

export interface FriendEntry {
  id: string;
  callsign: string;
  platform: PlatformType;
  status: 'online' | 'in_match' | 'in_lobby' | 'offline';
  mmr: number;
  roomId?: string;
}

export interface LobbyConfig {
  roomId: string;
  name: string;
  hostId: string;
  hostCallsign: string;
  isPrivate: boolean;
  mapId: MapId;
  mode: GameModeId;
  maxPlayers: number;
  hazardIntensity: 'standard' | 'overdrive';
  friendlyFire: boolean;
  crossplayPool: boolean;
  playerCount: number;
  avgMmr: number;
}

export interface CombatantSnapshot {
  id: string;
  callsign: string;
  isBot: boolean;
  botPolicy?: 'charger' | 'kiter' | 'orbiter' | 'miner';
  robotClass: RobotClass;
  team: TeamId;
  platform: PlatformType;
  x: number;
  y: number;
  z: number;
  yaw: number;
  chassisYaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  ammo: number;
  maxAmmo: number;
  alive: boolean;
  respawnAt: number;
  kills: number;
  deaths: number;
  assists: number;
  damageDealt: number;
  oreMined: number;
  weaponId: WeaponId;
  beamHex: string;
  skinHex: string;
  dashing: boolean;
  shieldActive: boolean;
  overclocked: boolean;
  miningNodeId: string | null;
  slowedUntil: number;
  speaking: boolean;
}

export interface KillFeedEvent {
  id: string;
  attackerName: string;
  attackerTeam: TeamId | 'hazard';
  victimName: string;
  victimTeam: TeamId;
  weaponOrHazard: string;
  isHazard: boolean;
  timestamp: number;
}

export interface BeamVisualEvent {
  id: string;
  shooterId: string;
  start: Vec3;
  end: Vec3;
  colorHex: string;
  width: number;
  timestamp: number;
}

export interface AntiCheatAudit {
  packetsValidated: number;
  movementCorrections: number;
  rateLimitBlocks: number;
  losRejections: number;
  integrityStatus: 'verified' | 'flagged';
  lastCheckAt: number;
}

export interface MatchSnapshot {
  roomId: string;
  isPrivate?: boolean;
  mapId: MapId;
  mode: GameModeId;
  phase: 'active' | 'ended';
  elapsedSec: number;
  durationSec: number;
  scoreCobalt: number;
  scoreAmber: number;
  scoreLimit: number;
  teamCreditsCobalt: number;
  teamCreditsAmber: number;
  controlOwner: TeamId | 'contested' | 'neutral';
  controlProgress: number;
  players: CombatantSnapshot[];
  barriers: DestructibleBarrierState[];
  hazards: HazardRuntimeState[];
  oreNodes: OreNodeState[];
  killFeed: KillFeedEvent[];
  antiCheat: AntiCheatAudit;
}

export interface MatchmakingStatus {
  queued: boolean;
  mode: GameModeId;
  crossplay: boolean;
  elapsedSec: number;
  estimatedWaitSec: number;
  mmrWindowMin: number;
  mmrWindowMax: number;
  playersInPool: number;
}
