import type {
  AmmoPackId,
  AmmoPackSpec,
  ControllerConfig,
  CosmeticItem,
  GadgetId,
  GadgetSpec,
  LoadoutConfig,
  MapDefinition,
  MapId,
  PlatformType,
  PlayerCareerStats,
  PlayerProfile,
  RobotClass,
  RobotClassSpec,
  WeaponId,
  WeaponSpec,
} from './types.ts';
import { normalizeDailyMissions } from './dailyMissions.ts';

export const ROBOT_CLASSES: Record<RobotClass, RobotClassSpec> = {
  s1_striker: {
    id: 's1_striker',
    code: 'RM-S1',
    name: 'RoboMaster S1 Striker',
    role: 'Assault Combatant · 2-Axis Blaster',
    summary: 'High-mobility Mecanum rover with precision gimbal laser turret. Spends Team Credits to resupply ammo.',
    maxHp: 100,
    maxShield: 50,
    speedMult: 1.0,
    miningRatePerSec: 12,
    classSkillName: 'Overclock Surge',
    classSkillDesc: 'Boosts fire rate and dumps emitter heat for 4.5s.',
    classSkillCooldownSec: 11,
  },
  ep_miner: {
    id: 'ep_miner',
    code: 'RM-EP',
    name: 'RoboMaster EP Engineer',
    role: 'Unarmed Harvester · Robotic Arm',
    summary: 'Heavy armored engineer chassis without a blaster. Cannot fire bullets — mines Ore Veins at 3x speed to fund Team Credits and pulses ally shield repairs.',
    maxHp: 135,
    maxShield: 75,
    speedMult: 0.92,
    miningRatePerSec: 36,
    classSkillName: 'Turbo Extraction',
    classSkillDesc: 'Doubles ore extraction speed and pulses +30 Shield repair to nearby allies.',
    classSkillCooldownSec: 10,
  },
};

export function canRobotClassFire(robotClass: RobotClass): boolean {
  return robotClass !== 'ep_miner';
}

export function getInitialAmmoForClass(robotClass: RobotClass, weaponId: WeaponId): number {
  if (!canRobotClassFire(robotClass)) return 0;
  return WEAPONS[weaponId]?.magSize ?? 30;
}

export const AMMO_PACKS: Record<AmmoPackId, AmmoPackSpec> = {
  light_mag: {
    id: 'light_mag',
    name: 'Tactical Ammo Cell',
    shortLabel: '+15 Ammo',
    cost: 35,
    ammoGrant: 15,
    fullFill: false,
    healHull: 0,
    healShield: 0,
    resetHeat: false,
  },
  full_mag: {
    id: 'full_mag',
    name: 'Full Magazine Refill',
    shortLabel: 'Full Mag',
    cost: 65,
    ammoGrant: 0,
    fullFill: true,
    healHull: 0,
    healShield: 0,
    resetHeat: true,
  },
  combat_resupply: {
    id: 'combat_resupply',
    name: 'Combat Resupply + Repair',
    shortLabel: 'Ammo + HP',
    cost: 110,
    ammoGrant: 0,
    fullFill: true,
    healHull: 40,
    healShield: 40,
    resetHeat: true,
  },
  overcharge_cell: {
    id: 'overcharge_cell',
    name: 'Overcharge Supply Pod',
    shortLabel: 'Overcharge',
    cost: 145,
    ammoGrant: 0,
    fullFill: true,
    healHull: 55,
    healShield: 60,
    resetHeat: true,
  },
};

export const INITIAL_TEAM_CREDITS = 180;

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  pulse_carbine: {
    id: 'pulse_carbine',
    name: 'Pulse Carbine',
    role: 'Rapid Auto · 30 Rd Mag',
    damage: 22,
    fireIntervalMs: 145,
    heatPerShot: 7,
    coolRatePerSec: 34,
    pellets: 1,
    spreadRad: 0.012,
    range: 95,
    beamWidth: 0.045,
    magSize: 30,
    unlockXp: 0,
  },
  prism_railgun: {
    id: 'prism_railgun',
    name: 'Prism Railgun',
    role: 'High-Velocity · 10 Rd Mag',
    damage: 68,
    fireIntervalMs: 680,
    heatPerShot: 38,
    coolRatePerSec: 28,
    pellets: 1,
    spreadRad: 0.001,
    range: 140,
    beamWidth: 0.085,
    magSize: 10,
    unlockXp: 400,
  },
  scatter_projector: {
    id: 'scatter_projector',
    name: 'Scatter Projector',
    role: 'Multi-Beam · 18 Rd Mag',
    damage: 14,
    fireIntervalMs: 520,
    heatPerShot: 26,
    coolRatePerSec: 30,
    pellets: 5,
    spreadRad: 0.055,
    range: 42,
    beamWidth: 0.032,
    magSize: 18,
    unlockXp: 900,
  },
};

export const GADGETS: Record<GadgetId, GadgetSpec> = {
  phase_dash: {
    id: 'phase_dash',
    name: 'Phase Thruster',
    role: 'Directional Surge · +Speed',
    cooldownSec: 4.5,
    unlockXp: 0,
  },
  aegis_wall: {
    id: 'aegis_wall',
    name: 'Aegis Pulse Shield',
    role: 'Absorbs 55% Incoming Damage',
    cooldownSec: 10,
    unlockXp: 300,
  },
  emp_pulse: {
    id: 'emp_pulse',
    name: 'Arc Disruptor',
    role: 'Strips Nearby Shields · 11m',
    cooldownSec: 12,
    unlockXp: 750,
  },
};

export const COSMETICS: CosmeticItem[] = [
  { id: 'beam_cyan', category: 'beam', name: 'Cobalt Pulse', hex: '#06B6D4', unlockXp: 0 },
  { id: 'beam_amber', category: 'beam', name: 'Solar Amber', hex: '#F59E0B', unlockXp: 0 },
  { id: 'beam_emerald', category: 'beam', name: 'Emerald Surge', hex: '#10B981', unlockXp: 250 },
  { id: 'beam_crimson', category: 'beam', name: 'Crimson Nova', hex: '#EF4444', unlockXp: 650 },
  { id: 'beam_prismatic', category: 'beam', name: 'Prismatic White', hex: '#E0F2FE', unlockXp: 1400 },

  { id: 'skin_graphite', category: 'skin', name: 'Carbon Matte', hex: '#262F3F', secondaryHex: '#475569', unlockXp: 0 },
  { id: 'skin_titanium', category: 'skin', name: 'Brushed Titanium', hex: '#64748B', secondaryHex: '#CBD5E1', unlockXp: 350 },
  { id: 'skin_cobalt', category: 'skin', name: 'Anodized Cobalt', hex: '#0E7490', secondaryHex: '#22D3EE', unlockXp: 800 },
  { id: 'skin_sovereign', category: 'skin', name: 'Solar Sovereign', hex: '#B45309', secondaryHex: '#FBBF24', unlockXp: 1600 },

  { id: 'emblem_prism', category: 'emblem', name: 'Vector Prism', hex: '#06B6D4', unlockXp: 0 },
  { id: 'emblem_apex', category: 'emblem', name: 'Apex Chevron', hex: '#F59E0B', unlockXp: 500 },
  { id: 'emblem_nova', category: 'emblem', name: 'Nova Core', hex: '#10B981', unlockXp: 1200 },
];

export interface RankTier {
  name: string;
  minXp: number;
  color: string;
}

export const XP_RANKS: RankTier[] = [
  { name: 'Initiate', minXp: 0, color: '#94A3B8' },
  { name: 'Vector', minXp: 300, color: '#06B6D4' },
  { name: 'Vanguard', minXp: 800, color: '#10B981' },
  { name: 'Prism Knight', minXp: 1500, color: '#F59E0B' },
  { name: 'Apex Sovereign', minXp: 2500, color: '#EF4444' },
];

export function getXpRank(xp: number): { current: RankTier; next: RankTier | null; progress: number } {
  let current = XP_RANKS[0];
  let next: RankTier | null = XP_RANKS[1] ?? null;
  for (let i = 0; i < XP_RANKS.length; i++) {
    if (xp >= XP_RANKS[i].minXp) {
      current = XP_RANKS[i];
      next = XP_RANKS[i + 1] ?? null;
    }
  }
  const progress = next
    ? Math.min(1, Math.max(0, (xp - current.minXp) / (next.minXp - current.minXp)))
    : 1;
  return { current, next, progress };
}

export const DEFAULT_LOADOUT: LoadoutConfig = {
  robotClass: 's1_striker',
  weaponId: 'pulse_carbine',
  gadgetId: 'phase_dash',
  beamColorId: 'beam_cyan',
  skinId: 'skin_graphite',
  emblemId: 'emblem_prism',
};

export function sanitizeLoadoutForXp(
  requested: Partial<LoadoutConfig> | undefined,
  fallback: Partial<LoadoutConfig> | undefined,
  xp: number,
): LoadoutConfig {
  const safeXp = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  const fbClass: RobotClass =
    fallback?.robotClass === 's1_striker' || fallback?.robotClass === 'ep_miner'
      ? fallback.robotClass
      : DEFAULT_LOADOUT.robotClass;
  const fbWeapon: WeaponId =
    typeof fallback?.weaponId === 'string' && fallback.weaponId in WEAPONS
      ? (fallback.weaponId as WeaponId)
      : DEFAULT_LOADOUT.weaponId;
  const fbGadget: GadgetId =
    typeof fallback?.gadgetId === 'string' && fallback.gadgetId in GADGETS
      ? (fallback.gadgetId as GadgetId)
      : DEFAULT_LOADOUT.gadgetId;

  const pickClass = (id: unknown): RobotClass => {
    if (id === 's1_striker' || id === 'ep_miner') return id;
    return fbClass;
  };

  const pickWeapon = (id: unknown): WeaponId => {
    if (typeof id === 'string' && id in WEAPONS) {
      const spec = WEAPONS[id as WeaponId];
      if (safeXp >= spec.unlockXp) return spec.id;
    }
    return safeXp >= WEAPONS[fbWeapon].unlockXp ? fbWeapon : DEFAULT_LOADOUT.weaponId;
  };

  const pickGadget = (id: unknown): GadgetId => {
    if (typeof id === 'string' && id in GADGETS) {
      const spec = GADGETS[id as GadgetId];
      if (safeXp >= spec.unlockXp) return spec.id;
    }
    return safeXp >= GADGETS[fbGadget].unlockXp ? fbGadget : DEFAULT_LOADOUT.gadgetId;
  };

  const pickCosmetic = (id: unknown, category: 'beam' | 'skin' | 'emblem', fb: string | undefined, def: string): string => {
    if (typeof id === 'string') {
      const item = COSMETICS.find((c) => c.id === id && c.category === category);
      if (item && safeXp >= item.unlockXp) return item.id;
    }
    if (typeof fb === 'string') {
      const fbItem = COSMETICS.find((c) => c.id === fb && c.category === category);
      if (fbItem && safeXp >= fbItem.unlockXp) return fbItem.id;
    }
    return def;
  };

  return {
    robotClass: pickClass(requested?.robotClass),
    weaponId: pickWeapon(requested?.weaponId),
    gadgetId: pickGadget(requested?.gadgetId),
    beamColorId: pickCosmetic(requested?.beamColorId, 'beam', fallback?.beamColorId, DEFAULT_LOADOUT.beamColorId),
    skinId: pickCosmetic(requested?.skinId, 'skin', fallback?.skinId, DEFAULT_LOADOUT.skinId),
    emblemId: pickCosmetic(requested?.emblemId, 'emblem', fallback?.emblemId, DEFAULT_LOADOUT.emblemId),
  };
}

export const DEFAULT_CONTROLLER: ControllerConfig = {
  mouseSensitivity: 1.0,
  adsMultiplier: 0.55,
  fov: 74,
  invertY: false,
  crosshairStyle: 'precision',
  gamepadEnabled: true,
  leftStickDeadzone: 0.15,
  rightStickDeadzone: 0.12,
  gamepadSensitivity: 2.6,
  triggerThreshold: 0.25,
  vibrationEnabled: true,
  bindings: {
    fire: 'Mouse0 / RT',
    ads: 'Mouse2 / LT',
    dash: 'Shift / B',
    gadget: 'Q / RB',
    classSkill: 'E / Y',
    buyAmmo: 'B / DPadUp',
    reload: 'R / X',
    voicePtt: 'V / LB',
  },
};

function clampFinite(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeControllerConfig(raw?: Partial<ControllerConfig> | null): ControllerConfig {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawBindings =
    src.bindings && typeof src.bindings === 'object'
      ? (src.bindings as Partial<ControllerConfig['bindings']>)
      : {};
  const bindings = { ...DEFAULT_CONTROLLER.bindings };
  for (const key of Object.keys(DEFAULT_CONTROLLER.bindings) as Array<keyof ControllerConfig['bindings']>) {
    const val = rawBindings[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      bindings[key] = val.trim().slice(0, 24);
    }
  }
  const crosshairStyle =
    src.crosshairStyle === 'precision' || src.crosshairStyle === 'chevron' || src.crosshairStyle === 'ring'
      ? src.crosshairStyle
      : DEFAULT_CONTROLLER.crosshairStyle;

  return {
    mouseSensitivity: clampFinite(src.mouseSensitivity, 0.2, 3.0, DEFAULT_CONTROLLER.mouseSensitivity),
    adsMultiplier: clampFinite(src.adsMultiplier, 0.2, 1.5, DEFAULT_CONTROLLER.adsMultiplier),
    fov: Math.round(clampFinite(src.fov, 65, 105, DEFAULT_CONTROLLER.fov)),
    invertY: typeof src.invertY === 'boolean' ? src.invertY : DEFAULT_CONTROLLER.invertY,
    crosshairStyle,
    gamepadEnabled: typeof src.gamepadEnabled === 'boolean' ? src.gamepadEnabled : DEFAULT_CONTROLLER.gamepadEnabled,
    leftStickDeadzone: clampFinite(src.leftStickDeadzone, 0.02, 0.45, DEFAULT_CONTROLLER.leftStickDeadzone),
    rightStickDeadzone: clampFinite(src.rightStickDeadzone, 0.02, 0.45, DEFAULT_CONTROLLER.rightStickDeadzone),
    gamepadSensitivity: clampFinite(src.gamepadSensitivity, 0.5, 6.0, DEFAULT_CONTROLLER.gamepadSensitivity),
    triggerThreshold: clampFinite(src.triggerThreshold, 0.05, 0.9, DEFAULT_CONTROLLER.triggerThreshold),
    vibrationEnabled: typeof src.vibrationEnabled === 'boolean' ? src.vibrationEnabled : DEFAULT_CONTROLLER.vibrationEnabled,
    bindings,
  };
}

export function normalizePlayerProfile(
  raw: Partial<PlayerProfile> | null | undefined,
  fallbackId = 'op_local',
): PlayerProfile {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = typeof src.id === 'string' && src.id.trim() ? src.id.trim() : fallbackId;
  const callsign =
    typeof src.callsign === 'string' && src.callsign.trim()
      ? src.callsign.trim().slice(0, 18)
      : `Prism-${id.slice(-4).toUpperCase()}`;
  const platform: PlatformType =
    src.platform === 'pc' || src.platform === 'console' || src.platform === 'cloud' ? src.platform : 'pc';

  const rawStats = (src.stats && typeof src.stats === 'object' ? src.stats : {}) as Partial<PlayerCareerStats>;
  const nonNegInt = (v: unknown, fb = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fb;
  };
  const xp = nonNegInt(rawStats.xp, 0);

  const rawWs =
    rawStats.weaponStats && typeof rawStats.weaponStats === 'object'
      ? (rawStats.weaponStats as Partial<PlayerCareerStats['weaponStats']>)
      : {};
  const normWs = (wid: WeaponId) => {
    const w = rawWs[wid];
    return {
      kills: nonNegInt(w?.kills, 0),
      shotsFired: nonNegInt(w?.shotsFired, 0),
      shotsHit: nonNegInt(w?.shotsHit, 0),
      damageDealt: nonNegInt(w?.damageDealt, 0),
    };
  };

  const stats: PlayerCareerStats = {
    matchesPlayed: nonNegInt(rawStats.matchesPlayed, 0),
    wins: nonNegInt(rawStats.wins, 0),
    losses: nonNegInt(rawStats.losses, 0),
    kills: nonNegInt(rawStats.kills, 0),
    deaths: nonNegInt(rawStats.deaths, 0),
    assists: nonNegInt(rawStats.assists, 0),
    shotsFired: nonNegInt(rawStats.shotsFired, 0),
    shotsHit: nonNegInt(rawStats.shotsHit, 0),
    damageDealt: nonNegInt(rawStats.damageDealt, 0),
    hazardKills: nonNegInt(rawStats.hazardKills, 0),
    barriersDestroyed: nonNegInt(rawStats.barriersDestroyed, 0),
    oreMined: nonNegInt(rawStats.oreMined, 0),
    mmr: Math.max(400, nonNegInt(rawStats.mmr, 1250)),
    xp,
    credits: nonNegInt(rawStats.credits, 0),
    weaponStats: {
      pulse_carbine: normWs('pulse_carbine'),
      prism_railgun: normWs('prism_railgun'),
      scatter_projector: normWs('scatter_projector'),
    },
    recentMatches: Array.isArray(rawStats.recentMatches) ? rawStats.recentMatches.slice(0, 10) : [],
  };

  return {
    id,
    callsign,
    platform,
    crossplayEnabled: typeof src.crossplayEnabled === 'boolean' ? src.crossplayEnabled : true,
    loadout: sanitizeLoadoutForXp(src.loadout, DEFAULT_LOADOUT, xp),
    controller: normalizeControllerConfig(src.controller),
    stats,
    dailyMissions: normalizeDailyMissions(src.dailyMissions, id),
  };
}

export function canPurchaseAmmoPack(
  teamCredits: number,
  packId: AmmoPackId,
  currentAmmo: number,
  maxAmmo: number,
  hp: number,
  maxHp: number,
  shield: number,
  maxShield: number,
): { allowed: boolean; reason?: string } {
  const pack = AMMO_PACKS[packId];
  if (!pack) return { allowed: false, reason: 'invalid_pack' };
  if (teamCredits < pack.cost) return { allowed: false, reason: 'insufficient_credits' };
  const needsAmmo = maxAmmo > 0 && currentAmmo < maxAmmo;
  const needsHeal = (pack.healHull > 0 && hp < maxHp) || (pack.healShield > 0 && shield < maxShield);
  if (maxAmmo <= 0 && pack.healHull <= 0 && pack.healShield <= 0) {
    return { allowed: false, reason: 'ep_no_weapon' };
  }
  if (!needsAmmo && !needsHeal && !(maxAmmo > 0 && pack.resetHeat)) {
    return { allowed: false, reason: 'already_full' };
  }
  return { allowed: true };
}

export const MAPS: Record<MapId, MapDefinition> = {
  reactor_foundry: {
    id: 'reactor_foundry',
    name: 'Reactor Foundry',
    subtitle: 'Industrial Core · Aurum Ore Veins & Sweeper Lanes',
    halfSize: 56,
    fogColor: 0x090e17,
    skyTopColor: 0x0f172a,
    skyBottomColor: 0x1e293b,
    keyLightColor: 0xffedd5,
    accentColor: '#F59E0B',
    controlCore: { x: 0, y: 0.2, z: 0 },
    spawns: [
      { team: 'cobalt', x: -43, y: 0, z: 0, yaw: -Math.PI / 2 },
      { team: 'cobalt', x: -43, y: 0, z: -18, yaw: -1.96 },
      { team: 'cobalt', x: -43, y: 0, z: 18, yaw: -1.18 },
      { team: 'amber', x: 43, y: 0, z: 0, yaw: Math.PI / 2 },
      { team: 'amber', x: 43, y: 0, z: -18, yaw: 1.96 },
      { team: 'amber', x: 43, y: 0, z: 18, yaw: 1.18 },
      { team: 'neutral', x: -41, y: 0, z: -28, yaw: -2.2 },
      { team: 'neutral', x: 41, y: 0, z: 28, yaw: 0.94 },
    ],
    oreNodes: [
      { id: 'rf_ore_west', label: 'West Aurum Vein', x: -31, y: 0, z: -15, maxAmount: 180, tier: 'standard' },
      { id: 'rf_ore_east', label: 'East Aurum Vein', x: 31, y: 0, z: 15, maxAmount: 180, tier: 'standard' },
      { id: 'rf_ore_north', label: 'North High-Yield Vein', x: 0, y: 0, z: -27, maxAmount: 240, tier: 'rich' },
      { id: 'rf_ore_south', label: 'South High-Yield Vein', x: 0, y: 0, z: 27, maxAmount: 240, tier: 'rich' },
      { id: 'rf_ore_west_s', label: 'Southwest Seam', x: -31, y: 0, z: 15, maxAmount: 180, tier: 'standard' },
      { id: 'rf_ore_east_n', label: 'Northeast Seam', x: 31, y: 0, z: -15, maxAmount: 180, tier: 'standard' },
    ],
    colliders: [
      { id: 'rf_core_pedestal', x: 0, y: 0.4, z: 0, w: 8.0, h: 0.8, d: 8.0, materialTag: 'platform' },
      { id: 'rf_pillar_nw', x: -18, y: 3.0, z: -16, w: 4.2, h: 6.0, d: 4.2, materialTag: 'pillar' },
      { id: 'rf_pillar_sw', x: -18, y: 3.0, z: 16, w: 4.2, h: 6.0, d: 4.2, materialTag: 'pillar' },
      { id: 'rf_pillar_ne', x: 18, y: 3.0, z: -16, w: 4.2, h: 6.0, d: 4.2, materialTag: 'pillar' },
      { id: 'rf_pillar_se', x: 18, y: 3.0, z: 16, w: 4.2, h: 6.0, d: 4.2, materialTag: 'pillar' },
      { id: 'rf_deck_north', x: 0, y: 1.3, z: -34, w: 20, h: 2.6, d: 7.0, materialTag: 'platform' },
      { id: 'rf_deck_south', x: 0, y: 1.3, z: 34, w: 20, h: 2.6, d: 7.0, materialTag: 'platform' },
      { id: 'rf_ramp_nw_1', x: -16.25, y: 0.325, z: -34, w: 2.5, h: 0.65, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_nw_2', x: -13.75, y: 0.65, z: -34, w: 2.5, h: 1.3, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_nw_3', x: -11.25, y: 0.975, z: -34, w: 2.5, h: 1.95, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_ne_1', x: 16.25, y: 0.325, z: -34, w: 2.5, h: 0.65, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_ne_2', x: 13.75, y: 0.65, z: -34, w: 2.5, h: 1.3, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_ne_3', x: 11.25, y: 0.975, z: -34, w: 2.5, h: 1.95, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_sw_1', x: -16.25, y: 0.325, z: 34, w: 2.5, h: 0.65, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_sw_2', x: -13.75, y: 0.65, z: 34, w: 2.5, h: 1.3, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_sw_3', x: -11.25, y: 0.975, z: 34, w: 2.5, h: 1.95, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_se_1', x: 16.25, y: 0.325, z: 34, w: 2.5, h: 0.65, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_se_2', x: 13.75, y: 0.65, z: 34, w: 2.5, h: 1.3, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_ramp_se_3', x: 11.25, y: 0.975, z: 34, w: 2.5, h: 1.95, d: 5.0, materialTag: 'ramp' },
      { id: 'rf_wall_n1', x: -26, y: 1.9, z: -32, w: 3.0, h: 3.8, d: 9.0, materialTag: 'wall' },
      { id: 'rf_wall_s1', x: -26, y: 1.9, z: 32, w: 3.0, h: 3.8, d: 9.0, materialTag: 'wall' },
      { id: 'rf_wall_n2', x: 26, y: 1.9, z: -32, w: 3.0, h: 3.8, d: 9.0, materialTag: 'wall' },
      { id: 'rf_wall_s2', x: 26, y: 1.9, z: 32, w: 3.0, h: 3.8, d: 9.0, materialTag: 'wall' },
      { id: 'rf_wing_w1', x: -28, y: 1.4, z: -9.5, w: 2.2, h: 2.8, d: 5.5, materialTag: 'wall' },
      { id: 'rf_wing_w2', x: -28, y: 1.4, z: 9.5, w: 2.2, h: 2.8, d: 5.5, materialTag: 'wall' },
      { id: 'rf_wing_e1', x: 28, y: 1.4, z: -9.5, w: 2.2, h: 2.8, d: 5.5, materialTag: 'wall' },
      { id: 'rf_wing_e2', x: 28, y: 1.4, z: 9.5, w: 2.2, h: 2.8, d: 5.5, materialTag: 'wall' },
      { id: 'rf_bunker_nw', x: -35, y: 1.6, z: -20, w: 4.0, h: 3.2, d: 4.0, materialTag: 'wall' },
      { id: 'rf_bunker_sw', x: -35, y: 1.6, z: 20, w: 4.0, h: 3.2, d: 4.0, materialTag: 'wall' },
      { id: 'rf_bunker_ne', x: 35, y: 1.6, z: -20, w: 4.0, h: 3.2, d: 4.0, materialTag: 'wall' },
      { id: 'rf_bunker_se', x: 35, y: 1.6, z: 20, w: 4.0, h: 3.2, d: 4.0, materialTag: 'wall' },
    ],
    barriers: [
      { id: 'rf_bar_c1', x: -12.5, y: 1.0, z: -5.2, w: 1.4, h: 2.0, d: 4.4, maxHp: 130 },
      { id: 'rf_bar_c2', x: -12.5, y: 1.0, z: 5.2, w: 1.4, h: 2.0, d: 4.4, maxHp: 130 },
      { id: 'rf_bar_c3', x: 12.5, y: 1.0, z: -5.2, w: 1.4, h: 2.0, d: 4.4, maxHp: 130 },
      { id: 'rf_bar_c4', x: 12.5, y: 1.0, z: 5.2, w: 1.4, h: 2.0, d: 4.4, maxHp: 130 },
      { id: 'rf_bar_n', x: 0, y: 1.0, z: -22.5, w: 5.6, h: 2.0, d: 1.4, maxHp: 160 },
      { id: 'rf_bar_s', x: 0, y: 1.0, z: 22.5, w: 5.6, h: 2.0, d: 1.4, maxHp: 160 },
    ],
    hazards: [
      {
        id: 'rf_haz_pylon_n',
        kind: 'plasma_pylon',
        label: 'Plasma Arc Pylon (North)',
        x: 0,
        y: 0,
        z: -15.5,
        radius: 6.2,
        cycleSec: 11,
        telegraphSec: 2.2,
        activeSec: 2.4,
        phaseOffsetSec: 0,
        damagePerTick: 24,
      },
      {
        id: 'rf_haz_pylon_s',
        kind: 'plasma_pylon',
        label: 'Plasma Arc Pylon (South)',
        x: 0,
        y: 0,
        z: 15.5,
        radius: 6.2,
        cycleSec: 11,
        telegraphSec: 2.2,
        activeSec: 2.4,
        phaseOffsetSec: 5.5,
        damagePerTick: 24,
      },
      {
        id: 'rf_haz_sweeper_c',
        kind: 'laser_sweeper',
        label: 'Central Laser Sweeper',
        x: 0,
        y: 0.8,
        z: 0,
        radius: 21.0,
        cycleSec: 14,
        telegraphSec: 2.0,
        activeSec: 7.0,
        phaseOffsetSec: 2.0,
        damagePerTick: 18,
      },
      {
        id: 'rf_haz_coolant_w',
        kind: 'coolant_leak',
        label: 'Cryo Coolant Vent (West)',
        x: -22.0,
        y: 0,
        z: 0,
        radius: 5.2,
        cycleSec: 13,
        telegraphSec: 1.8,
        activeSec: 4.5,
        phaseOffsetSec: 3.0,
        damagePerTick: 8,
      },
      {
        id: 'rf_haz_coolant_e',
        kind: 'coolant_leak',
        label: 'Cryo Coolant Vent (East)',
        x: 22.0,
        y: 0,
        z: 0,
        radius: 5.2,
        cycleSec: 13,
        telegraphSec: 1.8,
        activeSec: 4.5,
        phaseOffsetSec: 8.0,
        damagePerTick: 8,
      },
    ],
  },
  cryo_relay: {
    id: 'cryo_relay',
    name: 'Cryo Relay',
    subtitle: 'Sub-Zero Array · Cryo Crystals & Prism Towers',
    halfSize: 56,
    fogColor: 0x08111d,
    skyTopColor: 0x0c192c,
    skyBottomColor: 0x162a45,
    keyLightColor: 0xe0f2fe,
    accentColor: '#06B6D4',
    controlCore: { x: 0, y: 0.2, z: 0 },
    spawns: [
      { team: 'cobalt', x: -43, y: 0, z: 0, yaw: -Math.PI / 2 },
      { team: 'cobalt', x: -43, y: 0, z: -19, yaw: -1.98 },
      { team: 'cobalt', x: -43, y: 0, z: 19, yaw: -1.16 },
      { team: 'amber', x: 43, y: 0, z: 0, yaw: Math.PI / 2 },
      { team: 'amber', x: 43, y: 0, z: -19, yaw: 1.98 },
      { team: 'amber', x: 43, y: 0, z: 19, yaw: 1.16 },
      { team: 'neutral', x: -41, y: 0, z: -28, yaw: -2.2 },
      { team: 'neutral', x: 41, y: 0, z: 28, yaw: 0.94 },
    ],
    oreNodes: [
      { id: 'cr_ore_west', label: 'West Cryo Vein', x: -31, y: 0, z: -14, maxAmount: 180, tier: 'standard' },
      { id: 'cr_ore_east', label: 'East Cryo Vein', x: 31, y: 0, z: 14, maxAmount: 180, tier: 'standard' },
      { id: 'cr_ore_north', label: 'North Rich Vein', x: 0, y: 0, z: -24, maxAmount: 240, tier: 'rich' },
      { id: 'cr_ore_south', label: 'South Rich Vein', x: 0, y: 0, z: 24, maxAmount: 240, tier: 'rich' },
      { id: 'cr_ore_west_s', label: 'Southwest Seam', x: -31, y: 0, z: 14, maxAmount: 180, tier: 'standard' },
      { id: 'cr_ore_east_n', label: 'Northeast Seam', x: 31, y: 0, z: -14, maxAmount: 180, tier: 'standard' },
    ],
    colliders: [
      { id: 'cr_core_ring', x: 0, y: 0.35, z: 0, w: 9.0, h: 0.7, d: 9.0, materialTag: 'platform' },
      { id: 'cr_tower_nw', x: -17, y: 3.5, z: -19, w: 4.6, h: 7.0, d: 4.6, materialTag: 'pillar' },
      { id: 'cr_tower_se', x: 17, y: 3.5, z: 19, w: 4.6, h: 7.0, d: 4.6, materialTag: 'pillar' },
      { id: 'cr_tower_ne', x: 17, y: 3.5, z: -19, w: 4.6, h: 7.0, d: 4.6, materialTag: 'pillar' },
      { id: 'cr_tower_sw', x: -17, y: 3.5, z: 19, w: 4.6, h: 7.0, d: 4.6, materialTag: 'pillar' },
      { id: 'cr_bunker_n', x: 0, y: 1.6, z: -31, w: 15.0, h: 3.2, d: 4.4, materialTag: 'wall' },
      { id: 'cr_bunker_s', x: 0, y: 1.6, z: 31, w: 15.0, h: 3.2, d: 4.4, materialTag: 'wall' },
      { id: 'cr_flank_w1', x: -27, y: 1.5, z: -11, w: 2.6, h: 3.0, d: 6.5, materialTag: 'wall' },
      { id: 'cr_flank_w2', x: -27, y: 1.5, z: 11, w: 2.6, h: 3.0, d: 6.5, materialTag: 'wall' },
      { id: 'cr_flank_e1', x: 27, y: 1.5, z: -11, w: 2.6, h: 3.0, d: 6.5, materialTag: 'wall' },
      { id: 'cr_flank_e2', x: 27, y: 1.5, z: 11, w: 2.6, h: 3.0, d: 6.5, materialTag: 'wall' },
      { id: 'cr_relay_nw', x: -36, y: 2.0, z: -20, w: 3.8, h: 4.0, d: 3.8, materialTag: 'pillar' },
      { id: 'cr_relay_sw', x: -36, y: 2.0, z: 20, w: 3.8, h: 4.0, d: 3.8, materialTag: 'pillar' },
      { id: 'cr_relay_ne', x: 36, y: 2.0, z: -20, w: 3.8, h: 4.0, d: 3.8, materialTag: 'pillar' },
      { id: 'cr_relay_se', x: 36, y: 2.0, z: 20, w: 3.8, h: 4.0, d: 3.8, materialTag: 'pillar' },
    ],
    barriers: [
      { id: 'cr_bar_w1', x: -15, y: 1.0, z: 0, w: 1.4, h: 2.0, d: 5.8, maxHp: 140 },
      { id: 'cr_bar_e1', x: 15, y: 1.0, z: 0, w: 1.4, h: 2.0, d: 5.8, maxHp: 140 },
      { id: 'cr_bar_n1', x: -7.5, y: 1.0, z: -20, w: 5.0, h: 2.0, d: 1.4, maxHp: 130 },
      { id: 'cr_bar_s1', x: 7.5, y: 1.0, z: 20, w: 5.0, h: 2.0, d: 1.4, maxHp: 130 },
    ],
    hazards: [
      {
        id: 'cr_haz_cool_n',
        kind: 'coolant_leak',
        label: 'Cryo Breach (North)',
        x: 0,
        y: 0,
        z: -14.5,
        radius: 6.4,
        cycleSec: 10,
        telegraphSec: 2.0,
        activeSec: 4.0,
        phaseOffsetSec: 0,
        damagePerTick: 10,
      },
      {
        id: 'cr_haz_cool_s',
        kind: 'coolant_leak',
        label: 'Cryo Breach (South)',
        x: 0,
        y: 0,
        z: 14.5,
        radius: 6.4,
        cycleSec: 10,
        telegraphSec: 2.0,
        activeSec: 4.0,
        phaseOffsetSec: 5.0,
        damagePerTick: 10,
      },
      {
        id: 'cr_haz_sweeper',
        kind: 'laser_sweeper',
        label: 'Cryo Array Sweeper',
        x: 0,
        y: 0.75,
        z: 0,
        radius: 22.0,
        cycleSec: 12,
        telegraphSec: 2.0,
        activeSec: 6.5,
        phaseOffsetSec: 1.5,
        damagePerTick: 20,
      },
      {
        id: 'cr_haz_pylon_w',
        kind: 'plasma_pylon',
        label: 'Relay Capacitor (West)',
        x: -23,
        y: 0,
        z: 0,
        radius: 5.4,
        cycleSec: 12,
        telegraphSec: 2.2,
        activeSec: 2.2,
        phaseOffsetSec: 4.0,
        damagePerTick: 24,
      },
      {
        id: 'cr_haz_pylon_e',
        kind: 'plasma_pylon',
        label: 'Relay Capacitor (East)',
        x: 23,
        y: 0,
        z: 0,
        radius: 5.4,
        cycleSec: 12,
        telegraphSec: 2.2,
        activeSec: 2.2,
        phaseOffsetSec: 9.0,
        damagePerTick: 24,
      },
    ],
  },
};
