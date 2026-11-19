import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateHazardState,
  isPlayerHitByHazard,
  rayIntersectAabb,
  rayIntersectSphere,
  resolvePlayerMovement,
} from './physics';
import { MAPS } from './catalog';

test('resolvePlayerMovement slides along walls and clamps to arena bounds', () => {
  const map = MAPS.reactor_foundry;
  const start = { x: -55.0, y: 0, z: 0 };
  const vel = { x: -10, y: 0, z: 5 };
  const res = resolvePlayerMovement(start, vel, 0.2, map.colliders, map.halfSize);
  assert.ok(res.pos.x >= -map.halfSize + 0.55);
  assert.ok(res.pos.z > 0);
  assert.equal(res.grounded, true);
});

test('rayIntersectAabb detects solid cover and misses open lane', () => {
  const wall = { id: 'w1', x: 0, y: 1.5, z: -10, w: 4, h: 3, d: 2 };
  const hit = rayIntersectAabb({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, wall, 50);
  assert.ok(hit !== null && Math.abs(hit - 9) < 0.01);

  const miss = rayIntersectAabb({ x: 5, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, wall, 50);
  assert.equal(miss, null);
});

test('rayIntersectSphere accurately detects combatant hitbox', () => {
  const hit = rayIntersectSphere({ x: 0, y: 1.5, z: 10 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1.5, z: 0 }, 0.65, 30);
  assert.ok(hit !== null && Math.abs(hit - 9.35) < 0.01);
});

test('evaluateHazardState transitions idle -> telegraph -> active deterministically', () => {
  const pylon = MAPS.reactor_foundry.hazards[0]; // cycle 11, telegraph 2.2, active 2.4 -> idle 6.4
  const idle = evaluateHazardState(pylon, 1.0, false);
  assert.equal(idle.phase, 'idle');

  const telegraph = evaluateHazardState(pylon, 7.0, false);
  assert.equal(telegraph.phase, 'telegraph');

  const active = evaluateHazardState(pylon, 9.2, false);
  assert.equal(active.phase, 'active');

  assert.equal(isPlayerHitByHazard({ x: pylon.x, y: 0, z: pylon.z }, pylon, active), true);
  assert.equal(isPlayerHitByHazard({ x: pylon.x + 20, y: 0, z: pylon.z }, pylon, active), false);
});

test('laser_sweeper hits ground units and clears elevated ramps/decks', () => {
  const sweeper = MAPS.reactor_foundry.hazards.find((h) => h.kind === 'laser_sweeper')!;
  const runtime = {
    id: sweeper.id,
    kind: sweeper.kind,
    phase: 'active' as const,
    progress: 0.5,
    sweepAngle: 0, // beam runs along X-axis
  };
  // Standing on beam line at y = 0 -> hit
  assert.equal(isPlayerHitByHazard({ x: 5, y: 0, z: 0 }, sweeper, runtime), true);
  // Positioned on elevated ramp/deck at y = 1.2 -> safe
  assert.equal(isPlayerHitByHazard({ x: 5, y: 1.2, z: 0 }, sweeper, runtime), false);
});

test('stepped ramps allow climbing onto Reactor Foundry elevated decks', () => {
  const map = MAPS.reactor_foundry;
  const res1 = resolvePlayerMovement({ x: -18.2, y: 0, z: -34 }, { x: 12, y: 0, z: 0 }, 0.1, map.colliders, map.halfSize);
  assert.equal(res1.pos.y, 0.65);
  assert.equal(res1.grounded, true);
});

test('sanitizeLoadoutForXp rejects locked weapons, gadgets, and cosmetics', async () => {
  const { DEFAULT_LOADOUT, sanitizeLoadoutForXp } = await import('./catalog');
  const blocked = sanitizeLoadoutForXp(
    {
      weaponId: 'scatter_projector', // 900 XP required
      gadgetId: 'emp_pulse', // 750 XP required
      beamColorId: 'beam_prismatic', // 1400 XP required
      skinId: 'skin_sovereign', // 1600 XP required
    },
    DEFAULT_LOADOUT,
    100,
  );
  assert.equal(blocked.weaponId, 'pulse_carbine');
  assert.equal(blocked.gadgetId, 'phase_dash');
  assert.equal(blocked.beamColorId, 'beam_cyan');
  assert.equal(blocked.skinId, 'skin_graphite');
});

test('rotateTowardsAngle smoothly limits angular step without 180-degree snap', async () => {
  const { rotateTowardsAngle, normalizeAngle } = await import('./physics');
  const next = rotateTowardsAngle(0, Math.PI, 0.2);
  assert.ok(Math.abs(next - 0.2) < 1e-5);
  const wrap = rotateTowardsAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
  assert.ok(Math.abs(normalizeAngle(wrap - (-Math.PI + 0.1))) < 1e-5);
});

test('computeObstacleAvoidanceDir steers around blocking walls instead of head-on collision', async () => {
  const { computeObstacleAvoidanceDir } = await import('./physics');
  const wall = { id: 'block', x: 0, y: 1.5, z: -2.0, w: 3.0, h: 3.0, d: 1.2 };
  const dir = computeObstacleAvoidanceDir({ x: 0, y: 0, z: 0 }, 0, -1, [wall], 56, 3.2);
  assert.ok(Math.abs(dir.x) > 0.35, `Expected sideways steer away from wall, got x=${dir.x}`);
});

test('extractOreFromNode depletes vein and schedules respawn cleanly', async () => {
  const { extractOreFromNode } = await import('./physics');
  const node = {
    id: 'ore_1',
    x: 0,
    y: 0,
    z: 0,
    amount: 20,
    maxAmount: 180,
    tier: 'standard' as const,
    depleted: false,
    respawnAt: 0,
  };
  const first = extractOreFromNode(node, 36, 0.5, 1000, 20000);
  assert.equal(first.extracted, 18);
  assert.equal(node.amount, 2);
  assert.equal(node.depleted, false);

  const second = extractOreFromNode(node, 36, 0.5, 2000, 20000);
  assert.equal(second.extracted, 2);
  assert.equal(node.amount, 0);
  assert.equal(node.depleted, true);
  assert.equal(node.respawnAt, 22000);
});

test('canPurchaseAmmoPack enforces team credit cost and full-stock guards', async () => {
  const { canPurchaseAmmoPack } = await import('./catalog');
  assert.equal(canPurchaseAmmoPack(30, 'light_mag', 0, 30, 100, 100, 50, 50).allowed, false);
  assert.equal(canPurchaseAmmoPack(100, 'light_mag', 30, 30, 100, 100, 50, 50).allowed, false);
  assert.equal(canPurchaseAmmoPack(100, 'light_mag', 10, 30, 100, 100, 50, 50).allowed, true);
  assert.equal(canPurchaseAmmoPack(120, 'combat_resupply', 30, 30, 60, 100, 50, 50).allowed, true);
});

test('normalizeControllerConfig and normalizePlayerProfile migrate legacy incomplete profiles cleanly', async () => {
  const { DEFAULT_CONTROLLER, normalizeControllerConfig, normalizePlayerProfile, sanitizeLoadoutForXp, DEFAULT_LOADOUT } = await import('./catalog');
  const legacyProfile = {
    id: 'op_legacy1',
    callsign: 'LegacyBot',
    loadout: {
      weaponId: 'pulse_carbine',
      gadgetId: 'phase_dash',
      beamColorId: 'beam_cyan',
      skinId: 'skin_graphite',
      emblemId: 'emblem_prism',
    },
    controller: {
      mouseSensitivity: 1.4,
      fov: 80,
      bindings: {
        fire: 'Mouse0 / RT',
        ads: 'Mouse2 / LT',
        jump: 'Space / A',
        dash: 'Shift / B',
        gadget: 'Q / RB',
        reload: 'R / X',
        voicePtt: 'V / LB',
      },
    },
    stats: {
      matchesPlayed: 4,
      wins: 2,
      losses: 2,
      kills: 15,
      deaths: 10,
      xp: 0,
      mmr: 1290,
      credits: 100,
    },
  } as unknown as Parameters<typeof normalizePlayerProfile>[0];

  const migrated = normalizePlayerProfile(legacyProfile);
  assert.equal(migrated.loadout.robotClass, 's1_striker');
  assert.equal('jump' in DEFAULT_CONTROLLER.bindings, false);
  assert.equal('jump' in migrated.controller.bindings, false);
  assert.equal(migrated.controller.bindings.classSkill, DEFAULT_CONTROLLER.bindings.classSkill);
  assert.equal(migrated.controller.bindings.buyAmmo, DEFAULT_CONTROLLER.bindings.buyAmmo);
  assert.equal(migrated.controller.mouseSensitivity, 1.4);
  assert.equal(migrated.controller.fov, 80);
  assert.ok(migrated.stats.weaponStats.pulse_carbine);
  assert.ok(migrated.stats.weaponStats.prism_railgun);
  assert.ok(migrated.stats.weaponStats.scatter_projector);

  const normCtrl = normalizeControllerConfig({
    fov: 999,
    bindings: { classSkill: '', jump: 'Space / A' } as unknown as (typeof DEFAULT_CONTROLLER)['bindings'],
  });
  assert.equal(normCtrl.fov, 105);
  assert.equal('jump' in normCtrl.bindings, false);
  assert.equal(normCtrl.bindings.classSkill, DEFAULT_CONTROLLER.bindings.classSkill);

  const safeLoadout = sanitizeLoadoutForXp(undefined, {} as typeof DEFAULT_LOADOUT, 0);
  assert.equal(safeLoadout.robotClass, 's1_striker');
  assert.equal(safeLoadout.weaponId, 'pulse_carbine');
  assert.equal(safeLoadout.gadgetId, 'phase_dash');
});

test('clampMuzzleOriginToBody keeps extended EP arm origin inside body collision radius near walls', async () => {
  const { clampMuzzleOriginToBody, PLAYER_RADIUS } = await import('./physics');
  // Wall spans z in [-2.0, -1.0], player stands right outside at z = -1.0 + PLAYER_RADIUS = -0.28
  const wall = { id: 'cover_wall', x: 0, y: 1.5, z: -1.5, w: 6.0, h: 3.0, d: 1.0 };
  const bodyPos = { x: 0, y: 0, z: -1.0 + PLAYER_RADIUS + 0.02 };
  // Extended gripper tip reaches 1.25m forward into z = -1.51 (inside the wall!)
  const extendedGripper = { x: 0, y: 0.9, z: bodyPos.z - 1.25 };
  const unclampedHit = rayIntersectAabb(extendedGripper, { x: 0, y: 0, z: 1 }, wall, 50);
  assert.equal(unclampedHit, 0, 'Unclamped extended arm clips wall at t=0');

  const safeOrigin = clampMuzzleOriginToBody(bodyPos, extendedGripper);
  const horizOffset = Math.hypot(safeOrigin.x - bodyPos.x, safeOrigin.z - bodyPos.z);
  assert.ok(horizOffset <= PLAYER_RADIUS - 0.2, `Expected safe offset < body radius, got ${horizOffset}`);
  const outwardHit = rayIntersectAabb(safeOrigin, { x: 0, y: 0, z: 1 }, wall, 50);
  assert.equal(outwardHit, null, 'Clamped muzzle origin sits cleanly outside wall and fires freely');
});

test('RoboMaster EP Engineer is intentionally unarmed with 0 ammo and cannot fire bullets', async () => {
  const { canPurchaseAmmoPack, canRobotClassFire, getInitialAmmoForClass } = await import('./catalog');
  assert.equal(canRobotClassFire('ep_miner'), false);
  assert.equal(canRobotClassFire('s1_striker'), true);
  assert.equal(getInitialAmmoForClass('ep_miner', 'pulse_carbine'), 0);
  assert.equal(getInitialAmmoForClass('ep_miner', 'prism_railgun'), 0);
  assert.equal(getInitialAmmoForClass('s1_striker', 'pulse_carbine'), 30);
  assert.equal(canPurchaseAmmoPack(300, 'full_mag', 0, 0, 135, 135, 75, 75).allowed, false);
  assert.equal(canPurchaseAmmoPack(300, 'combat_resupply', 0, 0, 100, 135, 75, 75).allowed, true);
});

test('all arena models (perimeter, landmark, ore veins, hazard towers) have active collision boxes', async () => {
  const { buildMapPropColliders, getArenaActiveColliders } = await import('./physics');
  for (const mapId of ['reactor_foundry', 'cryo_relay'] as const) {
    const map = MAPS[mapId];
    const props = buildMapPropColliders(map);
    // 4 perimeter + 2 landmark + 2*oreNodes + 2*hazards
    const expectedCount = 4 + 2 + map.oreNodes.length * 2 + map.hazards.length * 2;
    assert.equal(props.length, expectedCount);

    const active = getArenaActiveColliders(map, []);
    assert.equal(active.length, map.colliders.length + props.length + map.barriers.length);

    // Shooting at an ore node crystal should be blocked by its collider
    const ore = map.oreNodes[0];
    const oreShotHit = rayIntersectAabb(
      { x: ore.x - 6, y: 1.0, z: ore.z },
      { x: 1, y: 0, z: 0 },
      active.find((c) => c.id === `${ore.id}_crystal`)!,
      20,
    );
    assert.ok(oreShotHit !== null && oreShotHit < 6);

    // Shooting at a plasma pylon spire should be blocked by its collider
    const pylon = map.hazards.find((h) => h.kind === 'plasma_pylon')!;
    const hazShotHit = rayIntersectAabb(
      { x: pylon.x - 6, y: 1.2, z: pylon.z },
      { x: 1, y: 0, z: 0 },
      active.find((c) => c.id === `${pylon.id}_spire`)!,
      20,
    );
    assert.ok(hazShotHit !== null && hazShotHit < 6);

    // Robot driving straight at an ore node stops outside its plinth + PLAYER_RADIUS
    const moveRes = resolvePlayerMovement(
      { x: ore.x - 2.6, y: 0, z: ore.z },
      { x: 12, y: 0, z: 0 },
      0.2,
      active,
      map.halfSize,
    );
    assert.ok(moveRes.pos.x <= ore.x - 1.25 - 0.72 + 1e-4);
  }
});

test('robots collide physically with other robots without overlapping or clipping walls', async () => {
  const { PLAYER_RADIUS } = await import('./physics');
  const map = MAPS.reactor_foundry;
  const otherRobots = [{ x: -40, y: 0, z: 0 }];
  // Driving straight toward another robot at x=-40 should push/stop at >= 2 * PLAYER_RADIUS separation
  const res = resolvePlayerMovement(
    { x: -41.5, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    0.1,
    map.colliders,
    map.halfSize,
    otherRobots,
  );
  const dist = Math.hypot(res.pos.x - otherRobots[0].x, res.pos.z - otherRobots[0].z);
  assert.ok(dist >= PLAYER_RADIUS * 2 - 1e-4, `Expected robot separation >= ${PLAYER_RADIUS * 2}, got ${dist}`);
});

test('rayIntersectRobot detects oriented S1 turret/chassis and EP arm_rig hitboxes', async () => {
  const { rayIntersectRobot } = await import('./physics');
  // S1 Striker rotated 90 deg around Y (chassis length along X now)
  const s1Pose = {
    x: 0,
    y: 0,
    z: 0,
    chassisYaw: Math.PI / 2,
    aimYaw: 0,
    robotClass: 's1_striker' as const,
  };
  const chassisHit = rayIntersectRobot(
    { x: 0.6, y: 0.4, z: 5 },
    { x: 0, y: 0, z: -1 },
    s1Pose,
    20,
  );
  assert.equal(chassisHit?.part, 'chassis');

  const turretHit = rayIntersectRobot(
    { x: 0, y: 1.15, z: 5 },
    { x: 0, y: 0, z: -1 },
    s1Pose,
    20,
  );
  assert.equal(turretHit?.part, 'turret');

  // Outside robot width/height should miss cleanly
  const miss = rayIntersectRobot(
    { x: 1.5, y: 0.5, z: 5 },
    { x: 0, y: 0, z: -1 },
    s1Pose,
    20,
  );
  assert.equal(miss, null);

  // EP Engineer forward extended arm_rig hitbox at local z=-0.22
  const epPose = {
    x: 0,
    y: 0,
    z: 0,
    chassisYaw: 0,
    aimYaw: 0,
    robotClass: 'ep_miner' as const,
  };
  const armHit = rayIntersectRobot(
    { x: 5, y: 1.05, z: -0.65 },
    { x: -1, y: 0, z: 0 },
    epPose,
    20,
  );
  assert.equal(armHit?.part, 'arm_rig');
});
