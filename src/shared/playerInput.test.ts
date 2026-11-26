import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAYER_EYE_HEIGHT, PLAYER_RADIUS, rayIntersectAabb, rayIntersectRobot } from './physics.ts';
import {
  computePlayerShot,
  computeReconciliationAdjustment,
  dequeuePlayerInputs,
  enqueuePlayerInput,
  interpolatePlayerMotion,
  MOVEMENT_STEP_SEC,
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

test('fixed-timestep interpolation produces constant per-frame velocity with zero 20 Hz sawtooth', () => {
  // Reach steady-state run speed first
  let prev = idle;
  let curr = idle;
  for (let i = 0; i < 20; i++) {
    prev = curr;
    curr = stepPlayerMotion(curr, { ...forward, seq: i + 1 }, context);
  }
  const dt = 1 / 60;
  let clock = 0;
  let lastZ = interpolatePlayerMotion(prev, curr, 0).pos.z;
  const frameSteps: number[] = [];
  for (let frame = 0; frame < 18; frame++) {
    clock += dt;
    while (clock >= MOVEMENT_STEP_SEC) {
      clock -= MOVEMENT_STEP_SEC;
      prev = curr;
      curr = stepPlayerMotion(curr, { ...forward, seq: 30 + frame }, context);
    }
    const z = interpolatePlayerMotion(prev, curr, clock / MOVEMENT_STEP_SEC).pos.z;
    frameSteps.push(lastZ - z);
    lastZ = z;
  }
  const minStep = Math.min(...frameSteps);
  const maxStep = Math.max(...frameSteps);
  assert.ok(minStep > 0.1, `Expected monotonic forward motion, got minStep=${minStep}`);
  assert.ok(maxStep / minStep < 1.02, `Expected smooth velocity without 20 Hz sawtooth, got ratio=${maxStep / minStep}`);
});

test('reconciliation adjustment preserves exact visual continuity on snapshot arrival', () => {
  const prev = stepPlayerMotion(idle, { ...forward, seq: 1 }, context);
  const curr = stepPlayerMotion(prev, { ...forward, seq: 2 }, context);
  const alpha = 0.6;
  const beforeVisual = interpolatePlayerMotion(prev, curr, alpha).pos;

  // Simulate server pushing player back by 0.25m on Z
  const reconciled: PlayerMotion = {
    ...curr,
    pos: { x: curr.pos.x, y: curr.pos.y, z: curr.pos.z + 0.25 },
  };
  const adj = computeReconciliationAdjustment(prev, curr, reconciled, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(adj.snapped, false);
  const interpAfter = interpolatePlayerMotion(adj.prev, reconciled, alpha).pos;
  const afterVisual = {
    x: interpAfter.x + adj.offset.x,
    y: interpAfter.y + adj.offset.y,
    z: interpAfter.z + adj.offset.z,
  };
  assert.ok(Math.abs(afterVisual.z - beforeVisual.z) < 1e-9, 'Visual pose must not pop on reconciliation');

  // Large teleport (> 3m) snaps immediately
  const teleported: PlayerMotion = { ...curr, pos: { x: 20, y: 0, z: 20 } };
  const snapAdj = computeReconciliationAdjustment(prev, curr, teleported, { x: 0, y: 0, z: 0 }, 0);
  assert.equal(snapAdj.snapped, true);
  assert.deepEqual(snapAdj.offset, { x: 0, y: 0, z: 0 });
});

test('FIFO input queue absorbs jitter bursts without rubberbanding and blocks speed hacks', () => {
  // 1. Jitter scenario: tick 1 delayed (0 packets), tick 2 receives seq 1 & seq 2 together.
  const queue: PlayerInput[] = [];
  let credit = 0;
  let serverMotion = idle;
  let lastInputAtMs = 1000;

  // Tick 1 at t=1050ms: packet delayed, queue empty (< 180ms idle threshold)
  const tick1 = dequeuePlayerInputs(queue, credit, 1050, lastInputAtMs, false);
  assert.equal(tick1.commands.length, 0);
  credit = tick1.nextCredit;
  assert.equal(credit, 1);

  // Tick 2 at t=1100ms: both seq=1 and seq=2 arrive in a burst
  enqueuePlayerInput(queue, { ...forward, seq: 1 });
  enqueuePlayerInput(queue, { ...forward, seq: 2 });
  lastInputAtMs = 1095;
  const tick2 = dequeuePlayerInputs(queue, credit, 1100, lastInputAtMs, false);
  assert.equal(tick2.commands.length, 2);
  credit = tick2.nextCredit;
  assert.equal(credit, 0);
  for (const cmd of tick2.commands) serverMotion = stepPlayerMotion(serverMotion, cmd, context);

  // Client predicted seq=1 and seq=2 locally: must match server identically (zero rubberband!)
  let clientMotion = stepPlayerMotion(idle, { ...forward, seq: 1 }, context);
  clientMotion = stepPlayerMotion(clientMotion, { ...forward, seq: 2 }, context);
  assert.equal(serverMotion.pos.z, clientMotion.pos.z);

  // 2. Speed-hack attempt: malicious client floods 2 inputs every tick without missing ticks.
  const floodQueue: PlayerInput[] = [];
  let floodCredit = 0;
  let totalProcessed = 0;
  for (let tick = 0; tick < 10; tick++) {
    enqueuePlayerInput(floodQueue, { ...forward, seq: tick * 2 + 1 });
    enqueuePlayerInput(floodQueue, { ...forward, seq: tick * 2 + 2 });
    const res = dequeuePlayerInputs(floodQueue, floodCredit, 2000 + tick * 50, 2000 + tick * 50, false);
    totalProcessed += res.commands.length;
    floodCredit = res.nextCredit;
  }
  assert.equal(totalProcessed, 10, 'Authoritative server must cap sustained throughput to 1 input per tick');

  // 3. Idle braking after timeout & overflow dash preservation
  const idleTick = dequeuePlayerInputs([], 2, 5000, 4000, false);
  assert.deepEqual(idleTick.commands, [null]);
  assert.equal(idleTick.nextCredit, 0);

  const overflowQueue: PlayerInput[] = [];
  enqueuePlayerInput(overflowQueue, { ...forward, seq: 1, dash: true }, 2);
  enqueuePlayerInput(overflowQueue, { ...forward, seq: 2, dash: false }, 2);
  const droppedDash = enqueuePlayerInput(overflowQueue, { ...forward, seq: 3, dash: false }, 2);
  assert.equal(droppedDash, true);
  assert.equal(overflowQueue.length, 2);
});
