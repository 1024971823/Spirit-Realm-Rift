import assert from 'node:assert/strict';
import test from 'node:test';
import { MAPS } from './catalog';
import {
  buildMinimapFrame,
  classifyMinimapPlayerRelation,
  computeSweeperBeamSegment,
  yawToMinimapHeadingDeg,
} from './minimap';
import type { CombatantSnapshot, MatchSnapshot } from './types';

function makeCombatant(overrides: Partial<CombatantSnapshot> & { id: string }): CombatantSnapshot {
  return {
    callsign: overrides.id,
    team: 'cobalt',
    platform: 'pc',
    robotClass: 's1_striker',
    isBot: false,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    chassisYaw: 0,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    hp: 100,
    maxHp: 100,
    shield: 50,
    maxShield: 50,
    ammo: 30,
    maxAmmo: 30,
    alive: true,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    damageDealt: 0,
    oreMined: 0,
    weaponId: 'pulse_carbine',
    beamHex: '#06B6D4',
    skinHex: '#262F3F',
    dashing: false,
    shieldActive: false,
    overclocked: false,
    miningNodeId: null,
    slowedUntil: 0,
    speaking: false,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    roomId: 'PUBLIC-ALPHA',
    mapId: 'reactor_foundry',
    mode: 'team_clash',
    phase: 'active',
    elapsedSec: 25,
    durationSec: 180,
    scoreCobalt: 2,
    scoreAmber: 1,
    scoreLimit: 15,
    teamCreditsCobalt: 200,
    teamCreditsAmber: 180,
    controlOwner: 'cobalt',
    controlProgress: 0.5,
    players: [],
    barriers: [],
    hazards: [],
    oreNodes: [],
    killFeed: [],
    antiCheat: {
      packetsValidated: 100,
      movementCorrections: 0,
      rateLimitBlocks: 0,
      losRejections: 0,
      integrityStatus: 'verified',
      lastCheckAt: 1000,
    },
    ...overrides,
  };
}

test('buildMinimapFrame projects alive players, classifies roles, overrides local pose, and sorts local on top', () => {
  const map = MAPS.reactor_foundry;
  const snapshot = makeSnapshot({
    players: [
      makeCombatant({ id: 'me', team: 'cobalt', x: -10, z: 5, yaw: 0 }),
      makeCombatant({ id: 'ally_ep', team: 'cobalt', robotClass: 'ep_miner', x: -20, z: -12, miningNodeId: 'rf_ore_west' }),
      makeCombatant({ id: 'enemy_1', team: 'amber', x: 25, z: 8, yaw: Math.PI / 2 }),
      makeCombatant({ id: 'dead_bot', team: 'amber', alive: false, x: 5, z: 5 }),
    ],
  });

  const frame = buildMinimapFrame(map, snapshot, 'me', 'cobalt', {
    pos: { x: -12, y: 0, z: 6 },
    yaw: Math.PI / 2,
  });

  assert.equal(frame.players.length, 3);
  assert.equal(frame.players.some((p) => p.id === 'dead_bot'), false);

  // Local player sorted last so it paints on top
  const local = frame.players[frame.players.length - 1];
  assert.equal(local.id, 'me');
  assert.equal(local.relation, 'local');
  assert.equal(local.x, -12);
  assert.equal(local.z, 6);
  assert.equal(local.headingDeg, yawToMinimapHeadingDeg(Math.PI / 2));

  const allyMiner = frame.players.find((p) => p.id === 'ally_ep')!;
  assert.equal(allyMiner.relation, 'ally_miner');
  assert.equal(allyMiner.isMining, true);

  const enemy = frame.players.find((p) => p.id === 'enemy_1')!;
  assert.equal(enemy.relation, 'enemy');
});

test('buildMinimapFrame projects active and telegraph hazards including rotating laser sweeper beam endpoints', () => {
  const map = MAPS.reactor_foundry;
  const snapshot = makeSnapshot({
    hazards: [
      { id: 'rf_haz_pylon_n', kind: 'plasma_pylon', phase: 'active', progress: 0.5, sweepAngle: 0 },
      { id: 'rf_haz_pylon_s', kind: 'plasma_pylon', phase: 'idle', progress: 0.2, sweepAngle: 0 },
      { id: 'rf_haz_sweeper_c', kind: 'laser_sweeper', phase: 'active', progress: 0.4, sweepAngle: 0 },
      { id: 'rf_haz_coolant_w', kind: 'coolant_leak', phase: 'telegraph', progress: 0.75, sweepAngle: 0 },
      { id: 'rf_haz_coolant_e', kind: 'coolant_leak', phase: 'idle', progress: 0.1, sweepAngle: 0 },
    ],
  });

  const frame = buildMinimapFrame(map, snapshot, 'me', 'cobalt');

  assert.equal(frame.activeHazardCount, 2);
  assert.equal(frame.telegraphHazardCount, 1);

  const sweeper = frame.hazards.find((h) => h.id === 'rf_haz_sweeper_c')!;
  assert.equal(sweeper.phase, 'active');
  assert.ok(sweeper.beamSegment);
  assert.equal(Math.round(sweeper.beamSegment.x1), -21);
  assert.equal(Math.round(sweeper.beamSegment.x2), 21);
  assert.equal(Math.round(sweeper.beamSegment.z1), 0);
  assert.equal(Math.round(sweeper.beamSegment.z2), 0);

  const coolant = frame.hazards.find((h) => h.id === 'rf_haz_coolant_w')!;
  assert.equal(coolant.phase, 'telegraph');
  assert.equal(coolant.beamSegment, null);
});

test('classifyMinimapPlayerRelation treats all non-local combatants as enemies in FFA mode', () => {
  assert.equal(
    classifyMinimapPlayerRelation({ id: 'other', team: 'cobalt', robotClass: 'ep_miner' }, 'me', 'cobalt', 'ffa'),
    'enemy',
  );
  assert.equal(
    classifyMinimapPlayerRelation({ id: 'me', team: 'cobalt', robotClass: 's1_striker' }, 'me', 'cobalt', 'ffa'),
    'local',
  );
});

test('computeSweeperBeamSegment rotates beam endpoints symmetrically around center', () => {
  const seg = computeSweeperBeamSegment(2, -3, 10, Math.PI / 2);
  assert.ok(Math.abs(seg.x1 - 2) < 1e-6);
  assert.ok(Math.abs(seg.x2 - 2) < 1e-6);
  assert.ok(Math.abs(seg.z1 - -13) < 1e-6);
  assert.ok(Math.abs(seg.z2 - 7) < 1e-6);
});
