import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAYER_EYE_HEIGHT, PLAYER_RADIUS, rayIntersectAabb, rayIntersectRobot } from './physics.ts';
import {
  computePlayerShot,
  readPlayerAim,
  readPlayerInput,
  stepPlayerMotion,
  type MovementContext,
  type PlayerInput,
  type PlayerMotion,
  type ShotTarget,
} from './playerInput.ts';

const origin = { x: 0, y: 0, z: 0 };
const idle: PlayerMotion = {
  pos: origin, vel: origin, grounded: true, dashRemaining: 0, dashCooldown: 0, chassisYaw: 0,
};
const context: MovementContext = { colliders: [], otherRobots: [], halfSize: 56, speedMult: 1, slowed: false };
const forward: PlayerInput = { matchId: 'round', seq: 1, moveX: 0, moveZ: -1, yaw: 0, pitch: 0, ads: false, dash: false };

test('input validates types, ignores client position, and caps diagonal movement', () => {
  assert.equal(readPlayerInput({ ...forward, seq: 0 }), null);
  assert.equal(readPlayerInput({ ...forward, moveZ: '-1' }), null);
  assert.equal(readPlayerInput({ ...forward, dash: 'false' }), null);
  assert.equal(readPlayerInput({ ...forward, matchId: '' }), null);
  assert.equal(readPlayerInput({ ...forward, moveX: Infinity }), null);
  const checked = readPlayerInput({ ...forward, moveX: 1, x: 100, vx: 99, pitch: 40 });
  assert.ok(checked);
  assert.ok(Math.abs(Math.hypot(checked.moveX, checked.moveZ) - 1) < 0.001);
  assert.equal(checked.pitch, 0.95);
  assert.equal('x' in checked, false);
  assert.ok(Number.isFinite(readPlayerAim({ ...forward, yaw: Number.MAX_VALUE })?.yaw));
});

test('a repeated dash request is bounded by the authoritative cooldown', () => {
  const dash = { ...forward, dash: true };
  let state = stepPlayerMotion(idle, dash, context);
  assert.ok(state.dashRemaining > 0);
  assert.ok(state.vel.z < stepPlayerMotion(idle, forward, context).vel.z);
  for (let i = 0; i < 20; i++) state = stepPlayerMotion(state, dash, context);
  assert.equal(state.dashRemaining, 0);
  assert.ok(state.dashCooldown > 0);
  assert.ok(Math.abs(state.vel.z) < 8.5);
});

test('20 Hz movement handles solid walls and brakes after input stops', () => {
  const wall = { id: 'wall', x: 0, y: 1.5, z: -3, w: 6, h: 3, d: 1 };
  const blocked = { ...context, colliders: [wall] };
  let onWall = idle;
  for (let i = 0; i < 16; i++) onWall = stepPlayerMotion(onWall, { ...forward, dash: true }, blocked);
  assert.ok(onWall.pos.z >= -3 + wall.d / 2 + PLAYER_RADIUS - 0.01);

  let released = stepPlayerMotion(idle, forward, context);
  const firstSpeed = Math.abs(released.vel.z);
  for (let i = 0; i < 10; i++) released = stepPlayerMotion(released, null, context);
  assert.ok(Math.abs(released.vel.z) < firstSpeed * 0.01);
});

test('shot origin comes from the body and solid cover intercepts the aim ray', () => {
  const target: ShotTarget = { ...origin, x: 0.78, z: -10, chassisYaw: 0, yaw: 0, robotClass: 's1_striker' };
  const aim = { yaw: 0, pitch: -0.08, ads: false };
  const shot = computePlayerShot(origin, aim, 90, [], [target]);
  const cover = { id: 'cover', x: 0, y: 1.5, z: -5, w: 5, h: 3, d: 1 };
  const aimedAtCover = computePlayerShot(origin, aim, 90, [cover], [target]);
  const targetDist = rayIntersectRobot(shot.origin, shot.dir, target, 90)?.dist;
  const coverDist = rayIntersectAabb(aimedAtCover.origin, aimedAtCover.dir, cover, 90);
  assert.deepEqual(shot.origin, { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 });
  assert.ok(targetDist !== undefined);
  assert.ok(coverDist !== null && coverDist < targetDist);
});
