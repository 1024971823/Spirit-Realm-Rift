import { rayIntersectAabb } from './physics.ts';
import type { AabbCollider, Vec3 } from './types.ts';

export const BASE_RUN_SPEED = 8.4; // m/s
export const DASH_SPEED_MULT = 2.15;
export const CRYO_SLOW_MULT = 0.58;

export interface MovementValidationResult {
  valid: boolean;
  correctedPos: Vec3;
  speedObserved: number;
  maxAllowedSpeed: number;
  reason?: string;
}

export function validateMovementDelta(
  prevPos: Vec3,
  nextPos: Vec3,
  dtSec: number,
  isDashing: boolean,
  isCryoSlowed: boolean,
  arenaHalfSize: number,
): MovementValidationResult {
  const bound = arenaHalfSize - 0.5;
  if (
    !Number.isFinite(nextPos.x) ||
    !Number.isFinite(nextPos.y) ||
    !Number.isFinite(nextPos.z) ||
    !Number.isFinite(dtSec)
  ) {
    return {
      valid: false,
      correctedPos: {
        x: Math.max(-bound, Math.min(bound, prevPos.x)),
        y: Math.max(-0.5, Math.min(8.5, prevPos.y)),
        z: Math.max(-bound, Math.min(bound, prevPos.z)),
      },
      speedObserved: 0,
      maxAllowedSpeed: BASE_RUN_SPEED,
      reason: 'invalid_coordinates',
    };
  }

  const safeDt = Math.max(0.016, Math.min(dtSec, 0.5));
  const dx = nextPos.x - prevPos.x;
  const dz = nextPos.z - prevPos.z;
  const horizDist = Math.hypot(dx, dz);
  const speedObserved = horizDist / safeDt;

  let maxAllowedSpeed = BASE_RUN_SPEED * 1.35; // generous network jitter margin
  if (isDashing) maxAllowedSpeed *= DASH_SPEED_MULT;
  if (isCryoSlowed) maxAllowedSpeed *= CRYO_SLOW_MULT * 1.25;

  // Out-of-bounds clamp
  const clampedY = Math.max(-0.5, Math.min(8.5, nextPos.y));

  if (horizDist > maxAllowedSpeed * safeDt + 1.35) {
    // Reject speed hack / teleportation and clamp back along vector
    const maxStep = maxAllowedSpeed * safeDt;
    const scale = horizDist > 0 ? maxStep / horizDist : 0;
    const correctedPos: Vec3 = {
      x: Math.max(-bound, Math.min(bound, prevPos.x + dx * scale)),
      y: clampedY,
      z: Math.max(-bound, Math.min(bound, prevPos.z + dz * scale)),
    };
    return {
      valid: false,
      correctedPos,
      speedObserved,
      maxAllowedSpeed,
      reason: 'speed_threshold_exceeded',
    };
  }

  return {
    valid: true,
    correctedPos: {
      x: Math.max(-bound, Math.min(bound, nextPos.x)),
      y: clampedY,
      z: Math.max(-bound, Math.min(bound, nextPos.z)),
    },
    speedObserved,
    maxAllowedSpeed,
  };
}

export function validateFireCadence(
  lastShotAtMs: number,
  nowMs: number,
  fireIntervalMs: number,
): { allowed: boolean; deltaMs: number } {
  const deltaMs = nowMs - lastShotAtMs;
  // Allow 15% jitter tolerance for packet arrival variance
  const minRequired = fireIntervalMs * 0.85;
  return {
    allowed: lastShotAtMs === 0 || deltaMs >= minRequired,
    deltaMs,
  };
}

export function validateFireOriginAndDir(
  authoritativePlayerPos: Vec3,
  eyeHeight: number,
  claimedOrigin: Vec3 | undefined,
  claimedDir: Vec3 | undefined,
  maxOriginOffset = 2.8,
): { valid: boolean; origin: Vec3; dir: Vec3; reason?: string } {
  const expectedOrigin: Vec3 = {
    x: authoritativePlayerPos.x,
    y: authoritativePlayerPos.y + eyeHeight,
    z: authoritativePlayerPos.z,
  };

  if (
    !claimedOrigin ||
    !claimedDir ||
    !Number.isFinite(claimedOrigin.x) ||
    !Number.isFinite(claimedOrigin.y) ||
    !Number.isFinite(claimedOrigin.z) ||
    !Number.isFinite(claimedDir.x) ||
    !Number.isFinite(claimedDir.y) ||
    !Number.isFinite(claimedDir.z)
  ) {
    return {
      valid: false,
      origin: expectedOrigin,
      dir: { x: 0, y: 0, z: -1 },
      reason: 'invalid_vector',
    };
  }

  const dirLen = Math.hypot(claimedDir.x, claimedDir.y, claimedDir.z);
  if (dirLen < 1e-4) {
    return {
      valid: false,
      origin: expectedOrigin,
      dir: { x: 0, y: 0, z: -1 },
      reason: 'zero_direction',
    };
  }

  const normDir: Vec3 = {
    x: claimedDir.x / dirLen,
    y: claimedDir.y / dirLen,
    z: claimedDir.z / dirLen,
  };

  const originDrift = Math.hypot(
    claimedOrigin.x - expectedOrigin.x,
    claimedOrigin.y - expectedOrigin.y,
    claimedOrigin.z - expectedOrigin.z,
  );

  if (originDrift > maxOriginOffset) {
    return {
      valid: false,
      origin: expectedOrigin,
      dir: normDir,
      reason: 'origin_spoof_rejected',
    };
  }

  return {
    valid: true,
    origin: claimedOrigin,
    dir: normDir,
  };
}

export function validateGadgetCooldown(
  lastGadgetAtMs: number,
  nowMs: number,
  cooldownSec: number,
): { allowed: boolean; remainingSec: number } {
  if (lastGadgetAtMs === 0) return { allowed: true, remainingSec: 0 };
  const minMs = cooldownSec * 1000 * 0.85;
  const elapsed = nowMs - lastGadgetAtMs;
  if (elapsed >= minMs) return { allowed: true, remainingSec: 0 };
  return { allowed: false, remainingSec: Number(((minMs - elapsed) / 1000).toFixed(1)) };
}

export function validateShotLineOfSight(
  origin: Vec3,
  dir: Vec3,
  targetDist: number,
  obstacles: AabbCollider[],
  maxWeaponRange: number,
): { clear: boolean; blockedBy?: string; obstacleDist?: number } {
  if (targetDist > maxWeaponRange + 1.5) {
    return { clear: false, blockedBy: 'out_of_range' };
  }

  let closestObstacle = Infinity;
  let blockerId: string | undefined;

  for (const box of obstacles) {
    const hitT = rayIntersectAabb(origin, dir, box, targetDist);
    if (hitT !== null && hitT < targetDist - 0.15 && hitT < closestObstacle) {
      closestObstacle = hitT;
      blockerId = box.id;
    }
  }

  if (blockerId) {
    return { clear: false, blockedBy: blockerId, obstacleDist: closestObstacle };
  }
  return { clear: true };
}
