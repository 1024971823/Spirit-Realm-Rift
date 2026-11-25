import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMatchContributionToDailyMissions,
  buildDailyMissionsForDay,
  claimAllClearBonus,
  claimDailyMission,
  countClaimableDailyRewards,
  DAILY_MISSION_ALL_CLEAR_BONUS,
  getUtcDayKey,
  msUntilNextUtcDay,
  normalizeDailyMissions,
} from './dailyMissions.ts';
import type { DailyMissionContribution } from './types.ts';

test('buildDailyMissionsForDay generates 3 deterministic missions covering combat, victory, and tactical slots', () => {
  const day = '2026-11-24';
  const a = buildDailyMissionsForDay(day, 'player-1');
  const b = buildDailyMissionsForDay(day, 'player-1');
  assert.deepEqual(a, b);
  assert.equal(a.dayKey, day);
  assert.equal(a.missions.length, 3);
  assert.equal(a.missions[0].kind, 'kills_with_robot');
  assert.equal(a.missions[0].robotClass, 's1_striker');
  assert.ok(a.missions[1].kind === 'win_matches' || a.missions[1].kind === 'play_matches');
  assert.ok(
    a.missions[2].kind === 'mine_ore_with_robot' ||
      a.missions[2].kind === 'deal_damage' ||
      a.missions[2].kind === 'destroy_barriers',
  );
  // Every mission has positive target and credit reward
  for (const m of a.missions) {
    assert.ok(m.target > 0);
    assert.ok(m.rewardCredits > 0);
  }
});

test('applyMatchContributionToDailyMissions advances robot-specific and match objectives and caps at target', () => {
  const now = Date.UTC(2026, 10, 24, 10, 0, 0);
  const initial = buildDailyMissionsForDay(getUtcDayKey(now), 'player-alpha');
  // Force known templates to exercise robot-specific kills, wins, and EP ore mining
  initial.missions = [
    { id: '2026-11-24:s1_kills_5', templateId: 's1_kills_5', kind: 'kills_with_robot', robotClass: 's1_striker', target: 5, progress: 0, rewardCredits: 150 },
    { id: '2026-11-24:win_2_matches', templateId: 'win_2_matches', kind: 'win_matches', target: 2, progress: 0, rewardCredits: 200 },
    { id: '2026-11-24:ep_mine_250', templateId: 'ep_mine_250', kind: 'mine_ore_with_robot', robotClass: 'ep_miner', target: 250, progress: 0, rewardCredits: 160 },
  ];

  const contrib: DailyMissionContribution = {
    won: true,
    matchesCompleted: 1,
    killsByRobot: { s1_striker: 6, ep_miner: 0 },
    oreMinedByRobot: { s1_striker: 50, ep_miner: 120 },
    damageDealt: 320,
    barriersDestroyed: 1,
  };

  // Run normalize first using matching day key
  const { state: s1, updates } = applyMatchContributionToDailyMissions(
    { dayKey: getUtcDayKey(now), missions: buildDailyMissionsForDay(getUtcDayKey(now), 'player-alpha').missions },
    'player-alpha',
    contrib,
    now,
  );
  assert.ok(updates.length >= 2);
  const combat = s1.missions[0];
  assert.equal(combat.progress, Math.min(combat.target, 6));
  // Verify clamping & completion
  const { state: s2 } = applyMatchContributionToDailyMissions(s1, 'player-alpha', {
    won: true,
    matchesCompleted: 3,
    killsByRobot: { s1_striker: 20, ep_miner: 0 },
    oreMinedByRobot: { s1_striker: 0, ep_miner: 400 },
    damageDealt: 1000,
    barriersDestroyed: 5,
  }, now + 1000);
  assert.ok(s2.missions.every(m => m.progress === m.target && m.completedAt !== undefined));
  assert.equal(countClaimableDailyRewards(s2), 4); // 3 missions + 1 all-clear bonus
});

test('claimDailyMission and claimAllClearBonus enforce completion and idempotency', () => {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  const base = buildDailyMissionsForDay(getUtcDayKey(now), 'player-beta');

  // Cannot claim incomplete mission or bonus
  assert.deepEqual(claimDailyMission(base, 'player-beta', base.missions[0].id, now), {
    ok: false,
    reason: 'not_completed',
  });
  assert.deepEqual(claimAllClearBonus(base, 'player-beta', now), {
    ok: false,
    reason: 'not_completed',
  });

  // Complete all 3 missions
  const { state: completed } = applyMatchContributionToDailyMissions(
    base,
    'player-beta',
    {
      won: true,
      matchesCompleted: 5,
      killsByRobot: { s1_striker: 15, ep_miner: 0 },
      oreMinedByRobot: { s1_striker: 0, ep_miner: 500 },
      damageDealt: 1200,
      barriersDestroyed: 10,
    },
    now,
  );
  // Ensure win_2_matches gets a second win if rolled
  const { state: allDone } = applyMatchContributionToDailyMissions(
    completed,
    'player-beta',
    {
      won: true,
      matchesCompleted: 1,
      killsByRobot: { s1_striker: 0, ep_miner: 0 },
      oreMinedByRobot: { s1_striker: 0, ep_miner: 0 },
      damageDealt: 0,
      barriersDestroyed: 0,
    },
    now + 500,
  );

  // Claim first mission
  const firstClaim = claimDailyMission(allDone, 'player-beta', allDone.missions[0].id, now + 1000);
  assert.equal(firstClaim.ok, true);
  if (!firstClaim.ok) throw new Error('expected ok');
  assert.equal(firstClaim.creditsAwarded, allDone.missions[0].rewardCredits);

  // Duplicate claim is rejected
  const dupClaim = claimDailyMission(firstClaim.state, 'player-beta', allDone.missions[0].id, now + 2000);
  assert.deepEqual(dupClaim, { ok: false, reason: 'already_claimed' });

  // Claim all-clear bonus once
  const bonusClaim = claimAllClearBonus(firstClaim.state, 'player-beta', now + 3000);
  assert.equal(bonusClaim.ok, true);
  if (!bonusClaim.ok) throw new Error('expected bonus ok');
  assert.equal(bonusClaim.creditsAwarded, DAILY_MISSION_ALL_CLEAR_BONUS);

  const dupBonus = claimAllClearBonus(bonusClaim.state, 'player-beta', now + 4000);
  assert.deepEqual(dupBonus, { ok: false, reason: 'already_claimed' });
});

test('normalizeDailyMissions rolls over cleanly on a new UTC day and msUntilNextUtcDay is accurate', () => {
  const day1 = Date.UTC(2026, 10, 24, 23, 59, 0);
  const day2 = Date.UTC(2026, 10, 25, 0, 1, 0);
  assert.equal(msUntilNextUtcDay(day1), 60_000);

  const prev = buildDailyMissionsForDay(getUtcDayKey(day1), 'player-gamma');
  prev.missions[0].progress = prev.missions[0].target;
  const rolled = normalizeDailyMissions(prev, 'player-gamma', day2);
  assert.equal(rolled.dayKey, '2026-11-25');
  assert.ok(rolled.missions.every(m => m.progress === 0 && m.claimedAt === undefined));
});
