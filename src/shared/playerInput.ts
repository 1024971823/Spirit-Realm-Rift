import { BASE_RUN_SPEED, CRYO_SLOW_MULT, DASH_SPEED_MULT } from './anticheat.ts';
import {
  clampMuzzleOriginToBody,
  normalizeAngle,
  PLAYER_EYE_HEIGHT,
  rayIntersectAabb,
  rayIntersectRobot,
  resolvePlayerMovement,
  rotateTowardsAngle,
} from './physics.ts';
import type { AabbCollider, CombatantSnapshot, Vec3 } from './types.ts';

export const MOVEMENT_STEP_SEC = 0.05;
export const DASH_DURATION_SEC = 0.24;
export const DASH_COOLDOWN_SEC = 3.2;
export const PHASE_DASH_DURATION_SEC = 0.35;

export interface PlayerAim {
  yaw: number;
  pitch: number;
  ads: boolean;
}

export interface PlayerInput extends PlayerAim {
  matchId: string;
  seq: number;
  moveX: number;
  moveZ: number;
  dash: boolean;
}

export interface PlayerMotion {
  pos: Vec3;
  vel: Vec3;
  chassisYaw: number;
  grounded: boolean;
  dashRemaining: number;
  dashCooldown: number;
}

export interface MovementContext {
  colliders: AabbCollider[];
  halfSize: number;
  otherRobots: Vec3[];
  speedMult: number;
  slowed: boolean;
  phaseDash?: boolean;
  lastAimYaw?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

export function readPlayerAim(value: unknown): PlayerAim | null {
  if (typeof value !== 'object' || value === null) return null;
  const { yaw, pitch, ads } = value as Record<string, unknown>;
  if (!isFiniteNumber(yaw) || !isFiniteNumber(pitch) || typeof ads !== 'boolean') return null;
  return { yaw: normalizeAngle(yaw % (2 * Math.PI)), pitch: clamp(pitch, -0.95, 0.95), ads };
}

export function readPlayerInput(value: unknown): PlayerInput | null {
  const aim = readPlayerAim(value);
  if (!aim) return null;
  const { matchId, seq, moveX, moveZ, dash } = value as Record<string, unknown>;
  if (
    typeof matchId !== 'string' || matchId.length === 0 || matchId.length > 80 ||
    !isFiniteNumber(seq) || !Number.isSafeInteger(seq) || seq < 1 ||
    !isFiniteNumber(moveX) || Math.abs(moveX) > 1.000001 ||
    !isFiniteNumber(moveZ) || Math.abs(moveZ) > 1.000001 ||
    typeof dash !== 'boolean'
  ) return null;
  const length = Math.max(1, Math.hypot(moveX, moveZ));
  return { ...aim, matchId, seq, moveX: moveX / length, moveZ: moveZ / length, dash };
}

export function playerMotionFromSnapshot(player: CombatantSnapshot): PlayerMotion {
  return {
    pos: { x: player.x, y: player.y, z: player.z },
    vel: { x: player.vx, y: player.vy, z: player.vz },
    chassisYaw: player.chassisYaw ?? player.yaw,
    grounded: player.grounded ?? Math.abs(player.vy) < 0.001,
    dashRemaining: player.dashRemaining ?? 0,
    dashCooldown: player.dashCooldown ?? 0,
  };
}

export function stepPlayerMotion(
  state: PlayerMotion,
  input: PlayerInput | null,
  context: MovementContext,
  dt = MOVEMENT_STEP_SEC,
): PlayerMotion {
  if (!(dt > 0)) return state;

  const startDash = input?.dash && state.dashCooldown <= 0;
  const dashRemaining = Math.max(
    startDash ? DASH_DURATION_SEC : state.dashRemaining,
    context.phaseDash ? PHASE_DASH_DURATION_SEC : 0,
  );
  const dashCooldown = startDash ? DASH_COOLDOWN_SEC : state.dashCooldown;
  const speed = BASE_RUN_SPEED * context.speedMult *
    (dashRemaining > 0 ? DASH_SPEED_MULT : 1) *
    (context.slowed ? CRYO_SLOW_MULT : 1) * (input?.ads ? 0.72 : 1);
  const alpha = 1 - Math.exp(-(state.grounded ? 14 : 6) * dt);
  const vel = {
    x: state.vel.x + ((input?.moveX ?? 0) * speed - state.vel.x) * alpha,
    y: state.vel.y - 19.5 * dt,
    z: state.vel.z + ((input?.moveZ ?? 0) * speed - state.vel.z) * alpha,
  };
  const { pos, grounded } = resolvePlayerMovement(
    state.pos, vel, dt, context.colliders, context.halfSize, context.otherRobots,
  );
  if (grounded && vel.y < 0) vel.y = 0;

  const facing = Math.hypot(vel.x, vel.z) > 0.65
    ? Math.atan2(-vel.x, -vel.z)
    : input?.yaw ?? context.lastAimYaw ?? state.chassisYaw;
  const rate = Math.abs(normalizeAngle(facing - state.chassisYaw)) > 1.85 ? 11.5 : 8.2;
  return {
    pos, vel, grounded,
    chassisYaw: rotateTowardsAngle(state.chassisYaw, facing, rate * dt),
    dashRemaining: Math.max(0, dashRemaining - dt),
    dashCooldown: Math.max(0, dashCooldown - dt),
  };
}

export function computePlayerCamera(
  pose: Vec3,
  aim: PlayerAim,
  colliders: AabbCollider[],
  halfSize = Infinity,
): { position: Vec3; forward: Vec3 } {
  const cosPitch = Math.cos(aim.pitch);
  const forward = { x: -Math.sin(aim.yaw) * cosPitch, y: Math.sin(aim.pitch), z: -Math.cos(aim.yaw) * cosPitch };
  const desiredDistance = aim.ads ? 2.65 : 4.55;
  const shoulderOffset = aim.ads ? 0.52 : 0.78;
  const lift = aim.ads ? 0.42 : 0.78;
  const pivot = { x: pose.x, y: pose.y + PLAYER_EYE_HEIGHT + lift * 0.42, z: pose.z };
  const offset = {
    x: -forward.x * desiredDistance + Math.cos(aim.yaw) * shoulderOffset,
    y: lift * 0.58 - forward.y * desiredDistance * 0.85,
    z: -forward.z * desiredDistance - Math.sin(aim.yaw) * shoulderOffset,
  };
  const backwards = unit(offset);
  let arm = Math.hypot(offset.x, offset.y, offset.z);
  for (const collider of colliders) {
    const at = rayIntersectAabb(pivot, backwards, collider, arm);
    if (at !== null && at < arm) arm = Math.max(0.45, at - 0.35);
  }
  const maxBound = halfSize - 0.85;
  return {
    position: {
      x: clamp(pivot.x + backwards.x * arm, -maxBound, maxBound),
      y: Math.max(0.55, pivot.y + backwards.y * arm),
      z: clamp(pivot.z + backwards.z * arm, -maxBound, maxBound),
    },
    forward,
  };
}

export type ShotTarget = Pick<CombatantSnapshot, 'x' | 'y' | 'z' | 'chassisYaw' | 'yaw' | 'robotClass'>;

export function computePlayerShot(
  pose: Vec3,
  aim: PlayerAim,
  range: number,
  colliders: AabbCollider[],
  targets: ShotTarget[] = [],
  halfSize = Infinity,
): { origin: Vec3; dir: Vec3 } {
  const { position, forward } = computePlayerCamera(pose, aim, colliders, halfSize);
  let distance = range;
  for (const collider of colliders) {
    const at = rayIntersectAabb(position, forward, collider, distance);
    if (at !== null && at > 1.5 && at < distance) distance = at;
  }
  for (const target of targets) {
    const hit = rayIntersectRobot(position, forward, { ...target, aimYaw: target.yaw }, distance);
    if (hit && hit.dist > 1.5 && hit.dist < distance) distance = hit.dist;
  }

  // Gameplay origin is fixed to this authoritative body, regardless of the animated mesh.
  const origin = clampMuzzleOriginToBody(pose, { x: pose.x, y: pose.y + PLAYER_EYE_HEIGHT, z: pose.z });
  const aimVector = {
    x: position.x + forward.x * distance - origin.x,
    y: Math.max(0.1, position.y + forward.y * distance) - origin.y,
    z: position.z + forward.z * distance - origin.z,
  };
  const ahead = aimVector.x * forward.x + aimVector.y * forward.y + aimVector.z * forward.z;
  return { origin, dir: ahead > 0.05 ? unit(aimVector) : forward };
}
