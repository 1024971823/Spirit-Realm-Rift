import type {
  AabbCollider,
  DestructibleBarrierDef,
  DestructibleBarrierState,
  HazardDef,
  HazardPhase,
  HazardRuntimeState,
  MapDefinition,
  OreNodeState,
  RobotClass,
  RobotColliderPart,
  RobotColliderPose,
  Vec3,
} from './types.ts';

export const PLAYER_RADIUS = 0.72;
export const PLAYER_EYE_HEIGHT = 1.35;
export const PLAYER_HEIGHT = 1.55;
export const ORE_MINE_RADIUS = 5.4;

export const ROBOT_HITBOX_SPECS: Record<RobotClass, RobotColliderPart[]> = {
  s1_striker: [
    { name: 'chassis', localX: 0, localY: 0.4, localZ: 0, w: 1.12, h: 0.8, d: 1.5, useAimYaw: false },
    { name: 'turret', localX: 0, localY: 1.14, localZ: 0, w: 0.82, h: 0.68, d: 0.96, useAimYaw: true },
  ],
  ep_miner: [
    { name: 'chassis', localX: 0, localY: 0.4, localZ: 0, w: 1.12, h: 0.8, d: 1.5, useAimYaw: false },
    { name: 'arm_rig', localX: 0, localY: 1.02, localZ: -0.22, w: 0.86, h: 0.68, d: 1.24, useAimYaw: false },
  ],
};

export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Rate-limited shortest-arc angular steering (prevents 180deg instant snaps / jerky turns).
 */
export function rotateTowardsAngle(current: number, target: number, maxStepRad: number): number {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxStepRad) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(diff) * maxStepRad);
}

/**
 * Multi-whisker steering probe around AABB colliders and arena bounds so robots glide around walls smoothly.
 */
export function computeObstacleAvoidanceDir(
  pos: Vec3,
  wishDirX: number,
  wishDirZ: number,
  colliders: AabbCollider[],
  arenaHalfSize: number,
  probeDist = 3.2,
  otherRobots: Vec3[] = [],
): { x: number; z: number } {
  const wishLen = Math.hypot(wishDirX, wishDirZ);
  if (wishLen < 1e-4) return { x: 0, z: 0 };
  const baseX = wishDirX / wishLen;
  const baseZ = wishDirZ / wishLen;
  const baseAngle = Math.atan2(baseZ, baseX);

  const offsets = [0, 0.55, -0.55, 1.05, -1.05, 1.65, -1.65];
  const bound = arenaHalfSize - 2.0;

  let bestX = baseX;
  let bestZ = baseZ;
  let bestScore = -Infinity;

  for (const offset of offsets) {
    const ang = baseAngle + offset;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);

    const endX = pos.x + dx * probeDist;
    const endZ = pos.z + dz * probeDist;
    if (Math.abs(endX) > bound || Math.abs(endZ) > bound) continue;

    let minHit = probeDist;
    const rayOrigin: Vec3 = { x: pos.x, y: pos.y + 0.65, z: pos.z };
    const rayDir: Vec3 = { x: dx, y: 0, z: dz };
    for (const box of colliders) {
      if (box.materialTag === 'ramp') continue;
      const boxTop = box.y + box.h * 0.5;
      if (boxTop < pos.y + 0.35) continue;
      // Inflate box slightly by robot radius for clean clearance
      const padded: AabbCollider = {
        ...box,
        w: box.w + PLAYER_RADIUS * 2.1,
        d: box.d + PLAYER_RADIUS * 2.1,
      };
      const t = rayIntersectAabb(rayOrigin, rayDir, padded, minHit);
      if (t !== null && t < minHit) {
        minHit = t;
      }
    }

    for (const other of otherRobots) {
      if (Math.abs(other.y - pos.y) > PLAYER_HEIGHT) continue;
      const t = rayIntersectSphere(
        rayOrigin,
        rayDir,
        { x: other.x, y: pos.y + 0.65, z: other.z },
        PLAYER_RADIUS * 2.1,
        minHit,
      );
      if (t !== null && t < minHit) {
        minHit = t;
      }
    }

    const clearanceFrac = minHit / probeDist;
    const alignScore = Math.cos(offset);
    const score = clearanceFrac * 2.4 + alignScore * 0.85;
    if (score > bestScore) {
      bestScore = score;
      bestX = dx;
      bestZ = dz;
    }
    if (offset === 0 && minHit >= probeDist * 0.96) {
      return { x: baseX, z: baseZ };
    }
  }

  return { x: bestX, z: bestZ };
}

export function extractOreFromNode(
  node: OreNodeState,
  ratePerSec: number,
  dt: number,
  nowMs: number,
  respawnDelayMs = 22000,
): { extracted: number } {
  if (node.depleted || node.amount <= 0 || dt <= 0 || ratePerSec <= 0) {
    return { extracted: 0 };
  }
  const want = Math.max(0, ratePerSec * dt);
  const extracted = Math.min(node.amount, want);
  node.amount = Math.max(0, node.amount - extracted);
  if (node.amount <= 0.01) {
    node.amount = 0;
    node.depleted = true;
    node.respawnAt = nowMs + respawnDelayMs;
  }
  return { extracted };
}

export function buildMapPropColliders(map: MapDefinition): AabbCollider[] {
  const hs = map.halfSize;
  const props: AabbCollider[] = [
    // Perimeter boundary walls
    { id: `${map.id}_perim_n`, x: 0, y: 4.5, z: -hs, w: hs * 2, h: 9.0, d: 1.4, materialTag: 'perimeter' },
    { id: `${map.id}_perim_s`, x: 0, y: 4.5, z: hs, w: hs * 2, h: 9.0, d: 1.4, materialTag: 'perimeter' },
    { id: `${map.id}_perim_w`, x: -hs, y: 4.5, z: 0, w: 1.4, h: 9.0, d: hs * 2, materialTag: 'perimeter' },
    { id: `${map.id}_perim_e`, x: hs, y: 4.5, z: 0, w: 1.4, h: 9.0, d: hs * 2, materialTag: 'perimeter' },
    // Central landmark monument (octagonal base socket + upper buttress/crystal spire)
    {
      id: `${map.id}_landmark_base`,
      x: map.controlCore.x,
      y: 0.72,
      z: map.controlCore.z,
      w: 6.4,
      h: 1.44,
      d: 6.4,
      materialTag: 'landmark',
    },
    {
      id: `${map.id}_landmark_spire`,
      x: map.controlCore.x,
      y: 5.2,
      z: map.controlCore.z,
      w: 5.2,
      h: 8.8,
      d: 5.2,
      materialTag: 'landmark',
    },
  ];

  // Mineral ore vein plinths and crystal clusters
  for (const ore of map.oreNodes) {
    const crystalH = ore.tier === 'rich' ? 2.8 : 2.4;
    props.push(
      {
        id: `${ore.id}_plinth`,
        x: ore.x,
        y: ore.y + 0.18,
        z: ore.z,
        w: 2.5,
        h: 0.36,
        d: 2.5,
        materialTag: 'ore',
      },
      {
        id: `${ore.id}_crystal`,
        x: ore.x,
        y: ore.y + crystalH * 0.5,
        z: ore.z,
        w: 1.5,
        h: crystalH,
        d: 1.5,
        materialTag: 'ore',
      },
    );
  }

  // Environmental hazard base pedestals & emitter towers
  for (const haz of map.hazards) {
    props.push({
      id: `${haz.id}_base`,
      x: haz.x,
      y: 0.19,
      z: haz.z,
      w: 1.75,
      h: 0.38,
      d: 1.75,
      materialTag: 'hazard',
    });
    if (haz.kind === 'plasma_pylon') {
      props.push({
        id: `${haz.id}_spire`,
        x: haz.x,
        y: 1.35,
        z: haz.z,
        w: 1.15,
        h: 2.7,
        d: 1.15,
        materialTag: 'hazard',
      });
    } else if (haz.kind === 'coolant_leak') {
      props.push({
        id: `${haz.id}_canisters`,
        x: haz.x,
        y: 0.78,
        z: haz.z,
        w: 1.25,
        h: 1.56,
        d: 1.25,
        materialTag: 'hazard',
      });
    } else {
      props.push({
        id: `${haz.id}_turret`,
        x: haz.x,
        y: 0.72,
        z: haz.z,
        w: 1.2,
        h: 1.1,
        d: 1.2,
        materialTag: 'hazard',
      });
    }
  }

  return props;
}

export function getActiveColliders(
  staticColliders: AabbCollider[],
  barrierDefs: DestructibleBarrierDef[],
  barrierStates: DestructibleBarrierState[],
  extraColliders: AabbCollider[] = [],
): AabbCollider[] {
  const result: AabbCollider[] = [...staticColliders, ...extraColliders];
  const stateMap = new Map<string, DestructibleBarrierState>();
  for (const s of barrierStates) stateMap.set(s.id, s);

  for (const b of barrierDefs) {
    const st = stateMap.get(b.id);
    if (!st || !st.destroyed) {
      result.push({
        id: b.id,
        x: b.x,
        y: b.y,
        z: b.z,
        w: b.w,
        h: b.h,
        d: b.d,
        destructible: true,
        materialTag: 'barrier',
      });
    }
  }
  return result;
}

export function getArenaActiveColliders(
  map: MapDefinition,
  barrierStates: DestructibleBarrierState[],
): AabbCollider[] {
  return getActiveColliders(map.colliders, map.barriers, barrierStates, buildMapPropColliders(map));
}

function pushOutStaticColliders(
  nx: number,
  ny: number,
  nz: number,
  velY: number,
  posY: number,
  colliders: AabbCollider[],
  limit: number,
  allowStepUp: boolean,
): { nx: number; ny: number; nz: number; grounded: boolean } {
  let outX = Math.max(-limit, Math.min(limit, nx));
  let outY = ny;
  let outZ = Math.max(-limit, Math.min(limit, nz));
  let grounded = outY <= 0;
  if (outY <= 0) outY = 0;

  for (const box of colliders) {
    const halfW = box.w * 0.5 + PLAYER_RADIUS;
    const halfD = box.d * 0.5 + PLAYER_RADIUS;
    const boxTop = box.y + box.h * 0.5;
    const boxBottom = box.y - box.h * 0.5;

    const withinXZ = Math.abs(outX - box.x) < halfW && Math.abs(outZ - box.z) < halfD;
    if (!withinXZ) continue;

    if (allowStepUp && (box.materialTag === 'ramp' || box.materialTag === 'platform')) {
      const maxStepUp = box.materialTag === 'ramp' ? 0.72 : 0.45;
      if (posY >= boxTop - maxStepUp && outY <= boxTop && velY <= 0.5) {
        outY = boxTop;
        grounded = true;
        continue;
      }
    }

    if (outY + PLAYER_HEIGHT > boxBottom && outY < boxTop - 0.1) {
      const dx = outX - box.x;
      const dz = outZ - box.z;
      const penX = halfW - Math.abs(dx);
      const penZ = halfD - Math.abs(dz);
      if (penX < penZ) {
        outX = box.x + (dx >= 0 ? halfW : -halfW);
      } else {
        outZ = box.z + (dz >= 0 ? halfD : -halfD);
      }
    }
  }

  outX = Math.max(-limit, Math.min(limit, outX));
  outZ = Math.max(-limit, Math.min(limit, outZ));
  return { nx: outX, ny: outY, nz: outZ, grounded };
}

export function resolvePlayerMovement(
  pos: Vec3,
  vel: Vec3,
  dt: number,
  colliders: AabbCollider[],
  arenaHalfSize: number,
  otherRobots: Vec3[] = [],
): { pos: Vec3; grounded: boolean } {
  const limit = arenaHalfSize - PLAYER_RADIUS - 0.3;
  const step1 = pushOutStaticColliders(
    pos.x + vel.x * dt,
    pos.y + vel.y * dt,
    pos.z + vel.z * dt,
    vel.y,
    pos.y,
    colliders,
    limit,
    true,
  );
  let nx = step1.nx;
  let ny = step1.ny;
  let nz = step1.nz;
  let grounded = step1.grounded;

  // Solid robot-to-robot body collision
  if (otherRobots.length > 0) {
    const minSep = PLAYER_RADIUS * 2;
    for (let pass = 0; pass < 2; pass++) {
      let pushed = false;
      for (let i = 0; i < otherRobots.length; i++) {
        const other = otherRobots[i];
        if (ny + PLAYER_HEIGHT <= other.y + 0.05 || ny >= other.y + PLAYER_HEIGHT - 0.05) {
          continue;
        }
        const dx = nx - other.x;
        const dz = nz - other.z;
        const dist = Math.hypot(dx, dz);
        if (dist < minSep) {
          pushed = true;
          if (dist < 1e-4) {
            const fallbackAngle = (i % 4) * (Math.PI * 0.5);
            nx += Math.cos(fallbackAngle) * minSep;
            nz += Math.sin(fallbackAngle) * minSep;
          } else {
            const push = minSep - dist;
            nx += (dx / dist) * push;
            nz += (dz / dist) * push;
          }
        }
      }
      if (!pushed) break;
      const clamped = pushOutStaticColliders(nx, ny, nz, vel.y, pos.y, colliders, limit, false);
      nx = clamped.nx;
      ny = clamped.ny;
      nz = clamped.nz;
      grounded = grounded || clamped.grounded;
    }
  }

  return { pos: { x: nx, y: ny, z: nz }, grounded };
}

/**
 * Clamps a dynamic 3D muzzle anchor inside the combatant's collision cylinder so an extended
 * robotic arm/barrel near a wall never places the ray origin inside an AABB collider.
 */
export function clampMuzzleOriginToBody(
  bodyPos: Vec3,
  rawOrigin: Vec3,
  maxHorizRadius = Math.max(0.2, PLAYER_RADIUS - 0.24),
  minY = 0.55,
  maxY = 1.65,
): Vec3 {
  const rx = Number.isFinite(rawOrigin.x) ? rawOrigin.x : bodyPos.x;
  const ry = Number.isFinite(rawOrigin.y) ? rawOrigin.y : bodyPos.y + 0.95;
  const rz = Number.isFinite(rawOrigin.z) ? rawOrigin.z : bodyPos.z;

  let dx = rx - bodyPos.x;
  let dz = rz - bodyPos.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz > maxHorizRadius && horiz > 1e-6) {
    const scale = maxHorizRadius / horiz;
    dx *= scale;
    dz *= scale;
  }
  const y = Math.max(bodyPos.y + minY, Math.min(bodyPos.y + maxY, ry));
  return {
    x: bodyPos.x + dx,
    y,
    z: bodyPos.z + dz,
  };
}

export function rayIntersectAabb(
  origin: Vec3,
  dir: Vec3,
  box: AabbCollider,
  maxDist: number,
): number | null {
  const minX = box.x - box.w * 0.5;
  const maxX = box.x + box.w * 0.5;
  const minY = box.y - box.h * 0.5;
  const maxY = box.y + box.h * 0.5;
  const minZ = box.z - box.d * 0.5;
  const maxZ = box.z + box.d * 0.5;

  let tmin = 0;
  let tmax = maxDist;

  const axes: Array<[number, number, number, number]> = [
    [origin.x, dir.x, minX, maxX],
    [origin.y, dir.y, minY, maxY],
    [origin.z, dir.z, minZ, maxZ],
  ];

  for (const [o, d, bmin, bmax] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < bmin || o > bmax) return null;
    } else {
      let t1 = (bmin - o) / d;
      let t2 = (bmax - o) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }

  return tmin >= 0 && tmin <= maxDist ? tmin : null;
}

export function rayIntersectSphere(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  radius: number,
  maxDist: number,
): number | null {
  const ocX = origin.x - center.x;
  const ocY = origin.y - center.y;
  const ocZ = origin.z - center.z;
  const b = ocX * dir.x + ocY * dir.y + ocZ * dir.z;
  const c = ocX * ocX + ocY * ocY + ocZ * ocZ - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const t = -b - sqrtD;
  if (t >= 0 && t <= maxDist) return t;
  const t2 = -b + sqrtD;
  if (t2 >= 0 && t2 <= maxDist) return t2;
  return null;
}

export function rayIntersectObb(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  w: number,
  h: number,
  d: number,
  yawY: number,
  maxDist: number,
): number | null {
  const cosY = Math.cos(yawY);
  const sinY = Math.sin(yawY);

  const relX = origin.x - center.x;
  const relY = origin.y - center.y;
  const relZ = origin.z - center.z;

  const localOrigin: Vec3 = {
    x: relX * cosY - relZ * sinY,
    y: relY,
    z: relX * sinY + relZ * cosY,
  };
  const localDir: Vec3 = {
    x: dir.x * cosY - dir.z * sinY,
    y: dir.y,
    z: dir.x * sinY + dir.z * cosY,
  };

  return rayIntersectAabb(
    localOrigin,
    localDir,
    { id: 'obb', x: 0, y: 0, z: 0, w, h, d },
    maxDist,
  );
}

export function rayIntersectRobot(
  origin: Vec3,
  dir: Vec3,
  robot: RobotColliderPose,
  maxDist: number,
): { dist: number; part: RobotColliderPart['name'] } | null {
  const parts = ROBOT_HITBOX_SPECS[robot.robotClass] || ROBOT_HITBOX_SPECS.s1_striker;
  let bestDist = maxDist;
  let bestPart: RobotColliderPart['name'] | null = null;

  for (const part of parts) {
    const yaw = part.useAimYaw ? (robot.aimYaw ?? robot.chassisYaw) : robot.chassisYaw;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const center: Vec3 = {
      x: robot.x + part.localX * cosY + part.localZ * sinY,
      y: robot.y + part.localY,
      z: robot.z - part.localX * sinY + part.localZ * cosY,
    };
    const hitT = rayIntersectObb(origin, dir, center, part.w, part.h, part.d, yaw, bestDist);
    if (hitT !== null && hitT <= bestDist) {
      bestDist = hitT;
      bestPart = part.name;
    }
  }

  return bestPart ? { dist: bestDist, part: bestPart } : null;
}

export function evaluateHazardState(
  hazard: HazardDef,
  matchElapsedSec: number,
  overdrive = false,
): HazardRuntimeState {
  const speedScale = overdrive ? 1.35 : 1.0;
  const t = ((matchElapsedSec * speedScale + hazard.phaseOffsetSec) % hazard.cycleSec + hazard.cycleSec) % hazard.cycleSec;
  const idleSec = Math.max(0.5, hazard.cycleSec - hazard.telegraphSec - hazard.activeSec);

  let phase: HazardPhase = 'idle';
  let progress = 0;

  if (t < idleSec) {
    phase = 'idle';
    progress = t / idleSec;
  } else if (t < idleSec + hazard.telegraphSec) {
    phase = 'telegraph';
    progress = (t - idleSec) / hazard.telegraphSec;
  } else {
    phase = 'active';
    progress = (t - idleSec - hazard.telegraphSec) / hazard.activeSec;
  }

  const sweepAngle =
    hazard.kind === 'laser_sweeper'
      ? ((matchElapsedSec * speedScale + hazard.phaseOffsetSec) * 1.15) % (Math.PI * 2)
      : 0;

  return {
    id: hazard.id,
    kind: hazard.kind,
    phase,
    progress,
    sweepAngle,
  };
}

export function isPlayerHitByHazard(
  playerPos: Vec3,
  hazard: HazardDef,
  runtime: HazardRuntimeState,
): boolean {
  if (runtime.phase !== 'active') return false;

  const dx = playerPos.x - hazard.x;
  const dz = playerPos.z - hazard.z;

  if (hazard.kind === 'laser_sweeper') {
    if (playerPos.y > 0.95) return false;
    const dist = Math.hypot(dx, dz);
    if (dist > hazard.radius || dist < 1.2) return false;
    const cosA = Math.cos(runtime.sweepAngle);
    const sinA = Math.sin(runtime.sweepAngle);
    const perpDist = Math.abs(dx * -sinA + dz * cosA);
    return perpDist < 0.75;
  }

  const distXZ = Math.hypot(dx, dz);
  return distXZ <= hazard.radius && playerPos.y < 2.8;
}
