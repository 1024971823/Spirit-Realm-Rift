import type {
  CombatantSnapshot,
  HazardKind,
  HazardPhase,
  MapDefinition,
  MatchSnapshot,
  RobotClass,
  TeamId,
  Vec3,
} from './types';

export type MinimapPlayerRelation = 'local' | 'ally_miner' | 'ally' | 'enemy';

export interface MinimapPlayerMarker {
  id: string;
  callsign: string;
  x: number;
  z: number;
  headingDeg: number;
  team: TeamId;
  robotClass: RobotClass;
  relation: MinimapPlayerRelation;
  isMining: boolean;
  shieldActive: boolean;
}

export interface MinimapHazardMarker {
  id: string;
  kind: HazardKind;
  label: string;
  x: number;
  z: number;
  radius: number;
  phase: HazardPhase;
  progress: number;
  sweepAngle: number;
  beamSegment: { x1: number; z1: number; x2: number; z2: number } | null;
}

export interface MinimapBarrierMarker {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  hpRatio: number;
}

export interface MinimapOreMarker {
  id: string;
  x: number;
  z: number;
  tier: 'standard' | 'rich';
  depleted: boolean;
}

export interface MinimapFrame {
  halfSize: number;
  players: MinimapPlayerMarker[];
  hazards: MinimapHazardMarker[];
  barriers: MinimapBarrierMarker[];
  oreNodes: MinimapOreMarker[];
  activeHazardCount: number;
  telegraphHazardCount: number;
  controlOwner: TeamId | 'contested' | 'neutral';
}

export interface LocalPlayerPoseOverride {
  pos: Vec3;
  yaw: number;
}

function clampCoord(val: number, halfSize: number, margin = 1.4): number {
  const limit = Math.max(1, halfSize - margin);
  if (!Number.isFinite(val)) return 0;
  return Math.max(-limit, Math.min(limit, val));
}

export function yawToMinimapHeadingDeg(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const deg = ((-yaw * 180) / Math.PI) % 360;
  return deg < 0 ? deg + 360 : deg;
}

export function classifyMinimapPlayerRelation(
  player: Pick<CombatantSnapshot, 'id' | 'team' | 'robotClass'>,
  localPlayerId: string,
  localTeam: TeamId,
  mode: MatchSnapshot['mode'] | undefined,
): MinimapPlayerRelation {
  if (player.id === localPlayerId) return 'local';
  if (mode === 'ffa') return 'enemy';
  if (player.team === localTeam) {
    return player.robotClass === 'ep_miner' ? 'ally_miner' : 'ally';
  }
  return 'enemy';
}

export function computeSweeperBeamSegment(
  x: number,
  z: number,
  radius: number,
  sweepAngle: number,
): { x1: number; z1: number; x2: number; z2: number } {
  const cosA = Math.cos(sweepAngle);
  const sinA = Math.sin(sweepAngle);
  return {
    x1: x - cosA * radius,
    z1: z - sinA * radius,
    x2: x + cosA * radius,
    z2: z + sinA * radius,
  };
}

/**
 * Pure projection of network MatchSnapshot + static MapDefinition into render-ready
 * tactical minimap entities (real-time player poses, active/telegraph hazards,
 * destructible barriers, and ore veins).
 */
export function buildMinimapFrame(
  map: MapDefinition,
  snapshot: MatchSnapshot | null,
  localPlayerId: string,
  localTeam: TeamId,
  localOverride?: LocalPlayerPoseOverride,
): MinimapFrame {
  const halfSize = map.halfSize;

  // Project live environmental hazards matched by ID from snapshot
  const runtimeHazardMap = new Map(
    (snapshot?.hazards ?? []).map((rt) => [rt.id, rt]),
  );

  let activeHazardCount = 0;
  let telegraphHazardCount = 0;

  const hazards: MinimapHazardMarker[] = map.hazards.map((def, idx) => {
    const rt = runtimeHazardMap.get(def.id) ?? snapshot?.hazards[idx];
    const phase: HazardPhase = rt?.phase ?? 'idle';
    const progress = rt ? Math.max(0, Math.min(1, rt.progress)) : 0;
    const sweepAngle = rt?.sweepAngle ?? 0;

    if (phase === 'active') activeHazardCount += 1;
    else if (phase === 'telegraph') telegraphHazardCount += 1;

    const beamSegment =
      def.kind === 'laser_sweeper' && phase !== 'idle'
        ? computeSweeperBeamSegment(def.x, def.z, def.radius, sweepAngle)
        : null;

    return {
      id: def.id,
      kind: def.kind,
      label: def.label,
      x: def.x,
      z: def.z,
      radius: def.radius,
      phase,
      progress,
      sweepAngle,
      beamSegment,
    };
  });

  // Project non-destroyed destructible barriers
  const barrierStateMap = new Map(
    (snapshot?.barriers ?? []).map((b) => [b.id, b]),
  );
  const barriers: MinimapBarrierMarker[] = [];
  for (const def of map.barriers) {
    const st = barrierStateMap.get(def.id);
    if (st?.destroyed) continue;
    const hpRatio = st
      ? Math.max(0, Math.min(1, st.hp / Math.max(1, st.maxHp)))
      : 1;
    barriers.push({
      id: def.id,
      x: def.x,
      z: def.z,
      w: def.w,
      d: def.d,
      hpRatio,
    });
  }

  // Project live ore veins
  const oreStateMap = new Map(
    (snapshot?.oreNodes ?? []).map((o) => [o.id, o]),
  );
  const oreNodes: MinimapOreMarker[] = map.oreNodes.map((def) => {
    const rt = oreStateMap.get(def.id);
    return {
      id: def.id,
      x: def.x,
      z: def.z,
      tier: def.tier,
      depleted: Boolean(rt?.depleted),
    };
  });

  // Project alive players from snapshot (with 60fps local override for smooth self-tracking)
  const players: MinimapPlayerMarker[] = [];
  let hasLocalFromSnapshot = false;

  for (const p of snapshot?.players ?? []) {
    if (!p.alive) continue;
    const isLocal = p.id === localPlayerId;
    if (isLocal) hasLocalFromSnapshot = true;

    const rawX = isLocal && localOverride ? localOverride.pos.x : p.x;
    const rawZ = isLocal && localOverride ? localOverride.pos.z : p.z;
    const rawYaw = isLocal && localOverride ? localOverride.yaw : p.yaw;

    players.push({
      id: p.id,
      callsign: p.callsign,
      x: clampCoord(rawX, halfSize),
      z: clampCoord(rawZ, halfSize),
      headingDeg: yawToMinimapHeadingDeg(rawYaw),
      team: p.team,
      robotClass: p.robotClass,
      relation: classifyMinimapPlayerRelation(p, localPlayerId, localTeam, snapshot?.mode),
      isMining: Boolean(p.miningNodeId),
      shieldActive: p.shieldActive,
    });
  }

  // If snapshot hasn't arrived yet but we have local pose, still place the local player marker
  if (!hasLocalFromSnapshot && !snapshot && localOverride) {
    players.push({
      id: localPlayerId || 'local',
      callsign: 'LOCAL',
      x: clampCoord(localOverride.pos.x, halfSize),
      z: clampCoord(localOverride.pos.z, halfSize),
      headingDeg: yawToMinimapHeadingDeg(localOverride.yaw),
      team: localTeam,
      robotClass: 's1_striker',
      relation: 'local',
      isMining: false,
      shieldActive: false,
    });
  }

  // Sort so local player always renders on top of allies & enemies
  players.sort((a, b) => {
    if (a.relation === 'local') return 1;
    if (b.relation === 'local') return -1;
    return 0;
  });

  return {
    halfSize,
    players,
    hazards,
    barriers,
    oreNodes,
    activeHazardCount,
    telegraphHazardCount,
    controlOwner: snapshot?.controlOwner ?? 'neutral',
  };
}
