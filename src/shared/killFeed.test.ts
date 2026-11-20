import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyKillFeedInvolvement,
  createInitialKillFeedState,
  getKillFeedEntryPhase,
  getNextKillFeedTransitionMs,
  ingestKillFeedEvents,
  KILL_FEED_EXIT_MS,
  KILL_FEED_MAX_VISIBLE,
  KILL_FEED_TTL_MS,
  pruneExpiredKillFeed,
} from './killFeed';
import type { KillFeedEvent } from './types';

function makeEvent(overrides: Partial<KillFeedEvent> & { id: string }): KillFeedEvent {
  return {
    attackerId: 'bot_1',
    attackerName: 'S1-Valkyrie',
    attackerTeam: 'cobalt',
    victimId: 'bot_2',
    victimName: 'S1-Helios',
    victimTeam: 'amber',
    weaponOrHazard: 'Pulse Carbine',
    isHazard: false,
    timestamp: 10_000,
    ...overrides,
  };
}

test('ingestKillFeedEvents skips stale historical kills on initial join and keeps recent ones', () => {
  const now = 20_000;
  const stale = makeEvent({ id: 'kf_old', timestamp: now - 15_000 });
  const recent = makeEvent({ id: 'kf_recent', timestamp: now - 2_000 });

  const next = ingestKillFeedEvents(createInitialKillFeedState(), [stale, recent], now);

  assert.equal(next.initialized, true);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].event.id, 'kf_recent');
  assert.equal(next.items[0].expiresAtMs, now + (KILL_FEED_TTL_MS - 2_000));
});

test('ingestKillFeedEvents orders newest first, deduplicates IDs, and caps visible stack', () => {
  let state = ingestKillFeedEvents(createInitialKillFeedState(), [], 10_000);

  const batch1 = [
    makeEvent({ id: 'kf_1', timestamp: 10_100 }),
    makeEvent({ id: 'kf_2', timestamp: 10_200 }),
    makeEvent({ id: 'kf_3', timestamp: 10_300 }),
  ];
  state = ingestKillFeedEvents(state, batch1, 10_400);
  assert.deepEqual(
    state.items.map((i) => i.event.id),
    ['kf_3', 'kf_2', 'kf_1'],
  );

  // Re-sending same events must not duplicate them and should preserve reference stability
  const deduped = ingestKillFeedEvents(state, batch1, 10_500);
  assert.equal(deduped, state);
  assert.deepEqual(
    deduped.items.map((i) => i.event.id),
    ['kf_3', 'kf_2', 'kf_1'],
  );

  // Pushing 4 more events should scroll oldest out beyond KILL_FEED_MAX_VISIBLE (5)
  const batch2 = [
    ...batch1,
    makeEvent({ id: 'kf_4', timestamp: 10_600 }),
    makeEvent({ id: 'kf_5', timestamp: 10_700 }),
    makeEvent({ id: 'kf_6', timestamp: 10_800 }),
    makeEvent({ id: 'kf_7', timestamp: 10_900 }),
  ];
  state = ingestKillFeedEvents(deduped, batch2, 11_000);
  assert.equal(state.items.length, KILL_FEED_MAX_VISIBLE);
  assert.deepEqual(
    state.items.map((i) => i.event.id),
    ['kf_7', 'kf_6', 'kf_5', 'kf_4', 'kf_3'],
  );
});

test('pruneExpiredKillFeed, getKillFeedEntryPhase, and getNextKillFeedTransitionMs manage fade and expiry accurately', () => {
  let state = ingestKillFeedEvents(createInitialKillFeedState(), [], 1_000);
  state = ingestKillFeedEvents(state, [makeEvent({ id: 'kf_a', timestamp: 2_000 })], 2_000, {
    ttlMs: 5_000,
  });
  state = ingestKillFeedEvents(state, [makeEvent({ id: 'kf_b', timestamp: 4_000 })], 4_000, {
    ttlMs: 5_000,
  });

  const itemA = state.items.find((i) => i.event.id === 'kf_a')!;
  const fadeStartA = 7_000 - KILL_FEED_EXIT_MS;

  // Before fade window: active, next boundary is fadeStartA
  assert.equal(getKillFeedEntryPhase(itemA, 5_000), 'active');
  assert.equal(getNextKillFeedTransitionMs(state.items, 5_000), fadeStartA - 5_000);

  // Inside fade window: exiting, next boundary is exact expiry at 7000
  assert.equal(getKillFeedEntryPhase(itemA, fadeStartA), 'exiting');
  assert.equal(getNextKillFeedTransitionMs(state.items, fadeStartA), KILL_FEED_EXIT_MS);
  assert.equal(pruneExpiredKillFeed(state.items, 6_999).length, 2);

  // At t=7000, kf_a expires, leaving only kf_b
  const afterFirstExpiry = pruneExpiredKillFeed(state.items, 7_000);
  assert.deepEqual(
    afterFirstExpiry.map((i) => i.event.id),
    ['kf_b'],
  );

  // At t=9000, all entries expired
  const empty = pruneExpiredKillFeed(afterFirstExpiry, 9_000);
  assert.equal(empty.length, 0);
  assert.equal(getNextKillFeedTransitionMs(empty, 9_000), null);
});

test('classifyKillFeedInvolvement distinguishes local eliminations, local deaths, hazard deaths, and neutral kills', () => {
  const localKill = makeEvent({
    id: 'e1',
    attackerId: 'player_local',
    attackerName: 'Pilot-01',
    victimId: 'bot_9',
    victimName: 'S1-Kestrel',
  });
  assert.equal(classifyKillFeedInvolvement(localKill, 'player_local', 'Pilot-01'), 'local_elimination');

  const localDeath = makeEvent({
    id: 'e2',
    attackerId: 'bot_9',
    attackerName: 'S1-Kestrel',
    victimId: 'player_local',
    victimName: 'Pilot-01',
  });
  assert.equal(classifyKillFeedInvolvement(localDeath, 'player_local', 'Pilot-01'), 'local_death');

  const localHazardDeath = makeEvent({
    id: 'e3',
    attackerId: null,
    attackerName: 'Sweeper Beam',
    attackerTeam: 'hazard',
    victimId: 'player_local',
    victimName: 'Pilot-01',
    weaponOrHazard: 'Sweeper Beam',
    isHazard: true,
  });
  assert.equal(classifyKillFeedInvolvement(localHazardDeath, 'player_local', 'Pilot-01'), 'local_death');

  const botHazardDeath = makeEvent({
    id: 'e4',
    attackerId: null,
    attackerName: 'Sweeper Beam',
    attackerTeam: 'hazard',
    victimId: 'bot_5',
    victimName: 'EP-Forge',
    weaponOrHazard: 'Sweeper Beam',
    isHazard: true,
  });
  assert.equal(classifyKillFeedInvolvement(botHazardDeath, 'player_local', 'Pilot-01'), 'hazard_death');

  const neutralKill = makeEvent({
    id: 'e5',
    attackerId: 'bot_1',
    victimId: 'bot_2',
  });
  assert.equal(classifyKillFeedInvolvement(neutralKill, 'player_local', 'Pilot-01'), 'elimination');

  // Legacy fallback without attackerId / victimId matches by callsign
  const legacyLocalKill: KillFeedEvent = {
    id: 'e6',
    attackerName: 'Pilot-01',
    attackerTeam: 'cobalt',
    victimName: 'S1-Kestrel',
    victimTeam: 'amber',
    weaponOrHazard: 'Prism Railgun',
    isHazard: false,
    timestamp: 12_000,
  };
  assert.equal(classifyKillFeedInvolvement(legacyLocalKill, 'player_local', 'Pilot-01'), 'local_elimination');
});
