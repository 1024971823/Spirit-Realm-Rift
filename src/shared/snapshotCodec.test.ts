import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAPS } from './catalog.ts';
import { encodeCompactMatchSnapshot, SnapshotRehydrator } from './snapshotCodec.ts';
import type { MatchSnapshot } from './types.ts';

function makeFullSnapshot(): MatchSnapshot {
  const map = MAPS.reactor_foundry;
  return {
    roomId: 'ROOM-1',
    matchId: '11111111-2222-4333-8444-555555555555',
    serverTick: 120,
    serverTimeMs: 1700000000000,
    isPrivate: false,
    mapId: 'reactor_foundry',
    mode: 'team_clash',
    phase: 'active',
    elapsedSec: 42.123456789,
    durationSec: 240,
    scoreCobalt: 7,
    scoreAmber: 5,
    scoreLimit: 25,
    teamCreditsCobalt: 260,
    teamCreditsAmber: 195,
    controlOwner: 'neutral',
    controlProgress: 0,
    players: Array.from({ length: 6 }, (_, i) => ({
      id: `player-${i + 1}`,
      callsign: `Pilot-${i + 1}`,
      isBot: i >= 4,
      ...(i >= 4 ? { botPolicy: 'charger' as const } : {}),
      robotClass: i % 3 === 2 ? 'ep_miner' : 's1_striker',
      team: i < 3 ? 'cobalt' : 'amber',
      platform: 'pc',
      x: -12.3456789 + i * 4.123456,
      y: 0,
      z: 8.7654321 - i * 2.987654,
      yaw: 1.23456789,
      chassisYaw: 0.98765432,
      pitch: -0.054321,
      vx: 3.14159265,
      vy: 0,
      vz: -1.41421356,
      hp: i % 3 === 2 ? 135 : 100,
      maxHp: i % 3 === 2 ? 135 : 100,
      shield: i % 3 === 2 ? 75 : 50,
      maxShield: i % 3 === 2 ? 75 : 50,
      ammo: i % 3 === 2 ? 0 : 24,
      maxAmmo: i % 3 === 2 ? 0 : 30,
      alive: true,
      respawnAt: 0,
      kills: i === 0 ? 3 : 0,
      deaths: i === 3 ? 2 : 0,
      assists: 0,
      damageDealt: i === 0 ? 320 : 0,
      oreMined: i === 2 ? 140 : 0,
      weaponId: 'pulse_carbine',
      beamHex: i < 3 ? '#06B6D4' : '#F59E0B',
      skinHex: i < 3 ? '#0E7490' : '#B45309',
      dashing: false,
      shieldActive: false,
      overclocked: i === 0,
      miningNodeId: i === 2 ? 'rf_ore_west' : null,
      slowedUntil: 0,
      speaking: false,
      ...(i < 4
        ? {
            lastProcessedInputSeq: 100 + i,
            grounded: true,
            dashCooldown: 0,
            dashRemaining: 0,
            heat: i === 0 ? 28.4567 : 0,
            overheated: false,
            gadgetCooldown: 0,
            classSkillCooldown: i === 0 ? 4.3219 : 0,
          }
        : {}),
    })),
    barriers: map.barriers.map(b => ({
      id: b.id,
      hp: b.maxHp,
      maxHp: b.maxHp,
      destroyed: false,
      respawnAt: 0,
    })),
    hazards: map.hazards.map((h, idx) => ({
      id: h.id,
      kind: h.kind,
      phase: idx === 2 ? 'active' : 'idle',
      progress: idx === 2 ? 0.56789 : 0,
      sweepAngle: idx === 2 ? 2.3456789 : 0,
    })),
    oreNodes: map.oreNodes.map(o => ({
      id: o.id,
      x: o.x,
      y: o.y,
      z: o.z,
      amount: o.maxAmount,
      maxAmount: o.maxAmount,
      tier: o.tier,
      depleted: false,
      respawnAt: 0,
    })),
    killFeed: [
      {
        id: 'kf-1',
        attackerId: 'player-1',
        attackerName: 'Pilot-1',
        attackerTeam: 'cobalt',
        victimId: 'player-4',
        victimName: 'Pilot-4',
        victimTeam: 'amber',
        weaponOrHazard: 'Pulse Carbine',
        isHazard: false,
        timestamp: 1699999995000,
      },
    ],
    antiCheat: {
      packetsValidated: 480,
      movementCorrections: 0,
      rateLimitBlocks: 0,
      losRejections: 0,
      integrityStatus: 'verified',
      lastCheckAt: 1700000000000,
    },
  };
}

test('encodeCompactMatchSnapshot reduces 6-player match:state wire bytes by at least 50% and preserves protocol fields', () => {
  const full = makeFullSnapshot();
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  const compact = encodeCompactMatchSnapshot(full, {
    includeRosterMeta: false,
    includeKillFeed: false,
    includeAntiCheat: false,
  });
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));

  assert.ok(compactBytes < fullBytes * 0.5, `Expected >50% reduction: full=${fullBytes}B compact=${compactBytes}B`);
  assert.equal(compact.matchId, full.matchId);
  assert.equal(compact.serverTick, full.serverTick);
  assert.equal(compact.players[0].id, 'player-1');
  assert.equal(compact.players[0].lastProcessedInputSeq, 100);
  assert.equal(compact.barriers[0].destroyed, false);
  // Static map properties must be omitted from compact frames
  assert.equal('x' in compact.oreNodes[0], false);
  assert.equal('maxHp' in compact.barriers[0], false);
  assert.equal('kind' in compact.hazards[0], false);
});

test('SnapshotRehydrator faithfully restores full MatchSnapshot from initial full + compact frames', () => {
  const full = makeFullSnapshot();
  const rehydrator = new SnapshotRehydrator();

  // Initial room:joined frame primes roster/metadata cache
  const initial = rehydrator.hydrate(full);
  assert.equal(initial.players[0].callsign, 'Pilot-1');

  // Subsequent 20Hz compact frame omits static metadata, killFeed, and antiCheat
  const nextFull: MatchSnapshot = {
    ...full,
    serverTick: 121,
    elapsedSec: 42.17,
    scoreCobalt: 8,
    players: full.players.map((p, idx) =>
      idx === 0 ? { ...p, x: -11.5, z: 8.2, ammo: 23, lastProcessedInputSeq: 101 } : p,
    ),
  };
  const compact = encodeCompactMatchSnapshot(nextFull, {
    includeRosterMeta: false,
    includeKillFeed: false,
    includeAntiCheat: false,
  });
  const restored = rehydrator.hydrate(compact);

  assert.equal(restored.serverTick, 121);
  assert.equal(restored.scoreCobalt, 8);
  assert.equal(restored.durationSec, 240);
  assert.equal(restored.scoreLimit, 25);
  assert.equal(restored.isPrivate, false);
  assert.equal(restored.players[0].callsign, 'Pilot-1');
  assert.equal(restored.players[0].beamHex, '#06B6D4');
  assert.equal(restored.players[0].maxHp, 100);
  assert.equal(restored.players[0].maxAmmo, 30);
  assert.equal(restored.players[0].ammo, 23);
  assert.equal(restored.players[0].lastProcessedInputSeq, 101);
  assert.equal(restored.players[2].maxHp, 135);
  assert.equal(restored.players[2].maxAmmo, 0);
  assert.equal(restored.oreNodes[0].x, MAPS.reactor_foundry.oreNodes[0].x);
  assert.equal(restored.oreNodes[0].tier, MAPS.reactor_foundry.oreNodes[0].tier);
  assert.equal(restored.barriers[0].maxHp, MAPS.reactor_foundry.barriers[0].maxHp);
  assert.equal(restored.hazards[2].kind, 'laser_sweeper');
  assert.equal(restored.killFeed.length, 1);
  assert.equal(restored.antiCheat.packetsValidated, 480);
});
