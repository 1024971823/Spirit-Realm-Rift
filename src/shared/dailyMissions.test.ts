import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMatchContributionToDailyMissions,
  buildDailyMissionsForDay,
  claimAllClearBonus,
  claimDailyMission,
  computeServerResetDeadline,
  countClaimableDailyRewards,
  DAILY_MISSION_ALL_CLEAR_BONUS,
  evaluateDailyMissionEligibility,
  getUtcDayKey,
  msUntilNextUtcDay,
  normalizeDailyMissions,
  sanitizeServerDailyMissions,
  shouldRefreshDailyMissions,
} from './dailyMissions.ts';
import { normalizePlayerProfile } from './catalog.ts';
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
      a.missions[2].kind === 'destroy_barriers' ||
      a.missions[2].kind === 'ally_repair',
  );
  // Every mission has positive target and credit reward
  for (const m of a.missions) {
    assert.ok(m.target > 0);
    assert.ok(m.rewardCredits > 0);
  }
});

test('applyMatchContributionToDailyMissions advances robot-specific, collaborative repair, and match objectives and caps at target', () => {
  const now = Date.UTC(2026, 10, 24, 10, 0, 0);
  const contrib: DailyMissionContribution = {
    won: true,
    matchesCompleted: 1,
    killsByRobot: { s1_striker: 6, ep_miner: 0 },
    oreMinedByRobot: { s1_striker: 50, ep_miner: 120 },
    damageDealt: 320,
    barriersDestroyed: 1,
    allyRepair: 95,
  };

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
    allyRepair: 250,
  }, now + 1000);
  assert.ok(s2.missions.every(m => m.progress === m.target && m.completedAt !== undefined));
  assert.equal(countClaimableDailyRewards(s2), 4); // 3 missions + 1 all-clear bonus

  // Explicitly find a deterministic player seed that rolls ep_repair_150 and verify allyRepair progresses it
  let repairSeed = '';
  for (let i = 0; i < 64; i++) {
    const candidate = `repair-player-${i}`;
    if (buildDailyMissionsForDay(getUtcDayKey(now), candidate).missions[2].kind === 'ally_repair') {
      repairSeed = candidate;
      break;
    }
  }
  assert.ok(repairSeed.length > 0, 'Expected at least one seed to roll ep_repair_150');
  const { state: repaired } = applyMatchContributionToDailyMissions(
    null,
    repairSeed,
    {
      won: false,
      matchesCompleted: 1,
      killsByRobot: { s1_striker: 0, ep_miner: 0 },
      oreMinedByRobot: { s1_striker: 0, ep_miner: 0 },
      damageDealt: 0,
      barriersDestroyed: 0,
      allyRepair: 160,
    },
    now,
  );
  assert.equal(repaired.missions[2].kind, 'ally_repair');
  assert.equal(repaired.missions[2].progress, repaired.missions[2].target);
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
      allyRepair: 200,
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
      allyRepair: 0,
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

test('normalizeDailyMissions rolls over cleanly on a new UTC day and server reset deadline resists client clock skew', () => {
  const day1 = Date.UTC(2026, 10, 24, 23, 59, 0);
  const day2 = Date.UTC(2026, 10, 25, 0, 1, 0);
  assert.equal(msUntilNextUtcDay(day1), 60_000);

  // Even if client clock is skewed 6 hours behind, deadline anchored to server nextResetMs triggers exactly 60s later
  const skewedClientNow = day1 - 6 * 3600_000;
  const deadline = computeServerResetDeadline(60_000, skewedClientNow);
  assert.equal(shouldRefreshDailyMissions(deadline, skewedClientNow + 59_999), false);
  assert.equal(shouldRefreshDailyMissions(deadline, skewedClientNow + 60_000), true);

  const prev = buildDailyMissionsForDay(getUtcDayKey(day1), 'player-gamma');
  prev.missions[0].progress = prev.missions[0].target;
  const rolled = normalizeDailyMissions(prev, 'player-gamma', day2);
  assert.equal(rolled.dayKey, '2026-11-25');
  assert.ok(rolled.missions.every(m => m.progress === 0 && m.claimedAt === undefined));
});

test('evaluateDailyMissionEligibility enforces publicOnly, minMatchSec, and active participation', () => {
  const prodPolicy = { publicOnly: true, minMatchSec: 45 };
  const base = {
    isPublicMatch: true,
    cancelled: false,
    forfeited: false,
    elapsedSec: 90,
    reachedScoreLimit: false,
    damageDealt: 100,
    oreMined: 0,
    barriersDestroyed: 0,
    allyRepair: 0,
    coreControlSec: 0,
    kills: 1,
    policy: prodPolicy,
  };
  assert.deepEqual(evaluateDailyMissionEligibility(base), { eligible: true });
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, isPublicMatch: false }),
    { eligible: false, reason: 'private_room_ineligible' },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, isPublicMatch: false, policy: { publicOnly: false, minMatchSec: 20 } }),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, elapsedSec: 25, reachedScoreLimit: false }),
    { eligible: false, reason: 'match_too_short' },
  );
  // Reaching the score limit early still counts as a completed match
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, elapsedSec: 25, reachedScoreLimit: true }),
    { eligible: true },
  );
  // Pure AFK participant is rejected, while pure EP engineering participation (ore / repair / control) qualifies
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, kills: 0, damageDealt: 0 }),
    { eligible: false, reason: 'inactive_participant' },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, kills: 0, damageDealt: 0, oreMined: 30 }),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, kills: 0, damageDealt: 0, allyRepair: 25 }),
    { eligible: true },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, cancelled: true }),
    { eligible: false, reason: 'cancelled' },
  );
  assert.deepEqual(
    evaluateDailyMissionEligibility({ ...base, forfeited: true }),
    { eligible: false, reason: 'forfeited' },
  );
});

test('sanitizeServerDailyMissions and preserveMissionDay keep server dayKey and progress despite skewed local clock', () => {
  const serverDayKey = '2020-01-15';
  const serverState = buildDailyMissionsForDay(serverDayKey, 'player-skew');
  serverState.missions[0].progress = serverState.missions[0].target;
  serverState.missions[0].completedAt = 1579046400000;
  serverState.missions[0].claimedAt = 1579046500000;

  const sanitized = sanitizeServerDailyMissions(serverState, 'player-skew');
  assert.equal(sanitized.dayKey, serverDayKey);
  assert.equal(sanitized.missions[0].progress, serverState.missions[0].target);
  assert.equal(sanitized.missions[0].claimedAt, 1579046500000);

  const preservedProfile = normalizePlayerProfile(
    { id: 'player-skew', dailyMissions: serverState },
    'player-skew',
    { preserveMissionDay: true },
  );
  assert.equal(preservedProfile.dailyMissions?.dayKey, serverDayKey);
  assert.equal(preservedProfile.dailyMissions?.missions[0].progress, serverState.missions[0].target);
  assert.equal(preservedProfile.dailyMissions?.missions[0].claimedAt, 1579046500000);
});
