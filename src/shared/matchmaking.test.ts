import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMmrDelta,
  canCandidatesMatch,
  evaluateMatchOutcome,
  formBalancedMatch,
  getSkillTier,
} from './matchmaking';

test('calculateMmrDelta awards higher MMR for upset wins and penalizes losses', () => {
  const upsetWin = calculateMmrDelta(1100, 1450, true, 1.8);
  const expectedWin = calculateMmrDelta(1450, 1100, true, 1.2);
  const loss = calculateMmrDelta(1200, 1200, false, 0.7);
  assert.ok(upsetWin > expectedWin);
  assert.ok(loss < 0);
});

test('formBalancedMatch pairs players minimizing MMR spread and respects crossplay', () => {
  const now = 100_000;
  const candidates = [
    { playerId: 'p1', callsign: 'Alpha', mmr: 1500, platform: 'pc' as const, crossplayEnabled: true, queuedAtMs: now - 5000 },
    { playerId: 'p2', callsign: 'Bravo', mmr: 1480, platform: 'console' as const, crossplayEnabled: true, queuedAtMs: now - 4000 },
    { playerId: 'p3', callsign: 'Charlie', mmr: 1420, platform: 'cloud' as const, crossplayEnabled: true, queuedAtMs: now - 3000 },
    { playerId: 'p4', callsign: 'Delta', mmr: 1410, platform: 'pc' as const, crossplayEnabled: true, queuedAtMs: now - 2000 },
  ];

  const match = formBalancedMatch(candidates, now, 4);
  assert.ok(match !== null);
  assert.equal(match.cobalt.length, 2);
  assert.equal(match.amber.length, 2);
  assert.ok(match.mmrSpread <= 40);

  // Crossplay disabled blocks cross-platform match
  const pcOnly = { ...candidates[0], crossplayEnabled: false };
  const consoleOnly = { ...candidates[1], crossplayEnabled: false };
  assert.equal(canCandidatesMatch(pcOnly, consoleOnly, now), false);
});

test('getSkillTier maps MMR to expected competitive tiers', () => {
  assert.equal(getSkillTier(900).label, 'Bronze Vector');
  assert.equal(getSkillTier(1400).label, 'Cobalt Vanguard');
  assert.equal(getSkillTier(2100).label, 'Apex Sovereign');
});

test('evaluateMatchOutcome computes FFA winner by kills and real team MMR averages', () => {
  const ffaOutcome = evaluateMatchOutcome('ffa', 12, 8, [
    { id: 'p1', callsign: 'Vex', team: 'cobalt', kills: 4, deaths: 3, damageDealt: 500, mmr: 1400 },
    { id: 'p2', callsign: 'Nyx', team: 'amber', kills: 11, deaths: 2, damageDealt: 1300, mmr: 1500 },
    { id: 'p3', callsign: 'Kael', team: 'cobalt', kills: 8, deaths: 5, damageDealt: 900, mmr: 1200 },
  ]);
  assert.equal(ffaOutcome.winnerId, 'p2');
  assert.equal(ffaOutcome.winnerName, 'Nyx');
  assert.equal(ffaOutcome.placements.get('p2'), 1);
  assert.equal(ffaOutcome.placements.get('p3'), 2);
  assert.equal(ffaOutcome.avgCobaltMmr, 1300);
  assert.equal(ffaOutcome.avgAmberMmr, 1500);
});
