import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFireCadence,
  validateFireOriginAndDir,
  validateGadgetCooldown,
  validateMovementDelta,
  validateShotLineOfSight,
} from './anticheat';

test('validateMovementDelta allows normal running and dashes while clamping speed hacks and NaN', () => {
  const prev = { x: 0, y: 0, z: 0 };
  const normalMove = validateMovementDelta(prev, { x: 0.8, y: 0, z: 0 }, 0.1, false, false, 34);
  assert.equal(normalMove.valid, true);

  const speedHack = validateMovementDelta(prev, { x: 18, y: 0, z: 0 }, 0.1, false, false, 34);
  assert.equal(speedHack.valid, false);
  assert.equal(speedHack.reason, 'speed_threshold_exceeded');
  assert.ok(speedHack.correctedPos.x < 3.0);

  const nanMove = validateMovementDelta(prev, { x: Number.NaN, y: 0, z: 0 }, 0.1, false, false, 34);
  assert.equal(nanMove.valid, false);
  assert.equal(nanMove.reason, 'invalid_coordinates');
  assert.equal(nanMove.correctedPos.x, 0);
});

test('validateFireCadence blocks rapid-fire exploits', () => {
  const ok = validateFireCadence(1000, 1200, 150);
  assert.equal(ok.allowed, true);

  const cheat = validateFireCadence(1000, 1040, 150);
  assert.equal(cheat.allowed, false);
});

test('validateFireOriginAndDir rejects spoofed origins and normalizes direction', () => {
  const valid = validateFireOriginAndDir(
    { x: 5, y: 0, z: 5 },
    1.65,
    { x: 5.2, y: 1.65, z: 5 },
    { x: 0, y: 0, z: -5 },
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.dir.z, -1);

  const spoofed = validateFireOriginAndDir(
    { x: 5, y: 0, z: 5 },
    1.65,
    { x: 25, y: 1.65, z: 25 },
    { x: 0, y: 0, z: -1 },
  );
  assert.equal(spoofed.valid, false);
  assert.equal(spoofed.reason, 'origin_spoof_rejected');
  assert.equal(spoofed.origin.x, 5);
});

test('validateGadgetCooldown blocks gadget spam', () => {
  assert.equal(validateGadgetCooldown(0, 5000, 10).allowed, true);
  assert.equal(validateGadgetCooldown(1000, 3000, 10).allowed, false);
  assert.equal(validateGadgetCooldown(1000, 12000, 10).allowed, true);
});

test('validateShotLineOfSight rejects shots blocked by solid walls', () => {
  const obstacles = [{ id: 'solid_wall', x: 0, y: 1.5, z: -5, w: 6, h: 4, d: 1 }];
  const blocked = validateShotLineOfSight(
    { x: 0, y: 1.5, z: 0 },
    { x: 0, y: 0, z: -1 },
    15,
    obstacles,
    80,
  );
  assert.equal(blocked.clear, false);
  assert.equal(blocked.blockedBy, 'solid_wall');

  const clear = validateShotLineOfSight(
    { x: 0, y: 1.5, z: 0 },
    { x: 0, y: 0, z: -1 },
    3,
    obstacles,
    80,
  );
  assert.equal(clear.clear, true);
});
