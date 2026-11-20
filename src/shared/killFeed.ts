import type { KillFeedEvent } from './types';

export const KILL_FEED_TTL_MS = 6500;
export const KILL_FEED_EXIT_MS = 320;
export const KILL_FEED_MAX_VISIBLE = 5;
export const KILL_FEED_STALE_JOIN_MS = 7500;
export const KILL_FEED_MIN_INITIAL_TTL_MS = 1400;
export const KILL_FEED_SEEN_LIMIT = 120;

export type KillFeedInvolvement =
  | 'local_elimination'
  | 'local_death'
  | 'hazard_death'
  | 'elimination';

export type KillFeedEntryPhase = 'active' | 'exiting';

export interface TrackedKillFeedItem {
  event: KillFeedEvent;
  receivedAtMs: number;
  expiresAtMs: number;
  durationMs: number;
}

export interface KillFeedState {
  items: TrackedKillFeedItem[];
  seenIds: string[];
  initialized: boolean;
}

export interface KillFeedOptions {
  ttlMs?: number;
  maxVisible?: number;
  staleJoinMs?: number;
}

export function createInitialKillFeedState(): KillFeedState {
  return {
    items: [],
    seenIds: [],
    initialized: false,
  };
}

/**
 * Pure ingestion & scrolling-window manager for transient HUD kill feed entries.
 * - Newest events appear at index 0 so older entries smoothly scroll downward.
 * - Entries expire deterministically after `ttlMs` and never persist indefinitely.
 * - Initial room hydration ignores historical kills older than `staleJoinMs`.
 * - Preserves referential stability when no unseen events arrive and no items expire.
 */
export function ingestKillFeedEvents(
  state: KillFeedState,
  incoming: readonly KillFeedEvent[],
  nowMs: number,
  options: KillFeedOptions = {},
): KillFeedState {
  const ttlMs = options.ttlMs ?? KILL_FEED_TTL_MS;
  const maxVisible = options.maxVisible ?? KILL_FEED_MAX_VISIBLE;
  const staleJoinMs = options.staleJoinMs ?? KILL_FEED_STALE_JOIN_MS;

  const activeExisting = pruneExpiredKillFeed(state.items, nowMs);
  const expiredAny = activeExisting.length !== state.items.length;
  const seenSet = new Set(state.seenIds);

  let hasUnseen = false;
  for (const event of incoming) {
    if (!seenSet.has(event.id)) {
      hasUnseen = true;
      break;
    }
  }

  if (state.initialized && !hasUnseen && !expiredAny) {
    return state;
  }

  const nextSeen = [...state.seenIds];
  const newlyTracked: TrackedKillFeedItem[] = [];
  const sortedIncoming = [...incoming].sort((a, b) => a.timestamp - b.timestamp);

  for (const event of sortedIncoming) {
    if (seenSet.has(event.id)) continue;
    seenSet.add(event.id);
    nextSeen.push(event.id);

    if (!state.initialized) {
      const ageMs = nowMs - event.timestamp;
      if (ageMs > staleJoinMs) {
        continue;
      }
      const remainingMs =
        ageMs > 0
          ? Math.max(KILL_FEED_MIN_INITIAL_TTL_MS, ttlMs - ageMs)
          : ttlMs;
      newlyTracked.push({
        event,
        receivedAtMs: nowMs,
        expiresAtMs: nowMs + remainingMs,
        durationMs: remainingMs,
      });
    } else {
      newlyTracked.push({
        event,
        receivedAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        durationMs: ttlMs,
      });
    }
  }

  // Prepend newest events at top (reverse chronological) so older entries scroll downward.
  const combined = [...newlyTracked.reverse(), ...activeExisting].slice(0, maxVisible);

  const trimmedSeen =
    nextSeen.length > KILL_FEED_SEEN_LIMIT
      ? nextSeen.slice(nextSeen.length - KILL_FEED_SEEN_LIMIT)
      : nextSeen;

  return {
    items: combined,
    seenIds: trimmedSeen,
    initialized: true,
  };
}

export function pruneExpiredKillFeed(
  items: readonly TrackedKillFeedItem[],
  nowMs: number,
): TrackedKillFeedItem[] {
  return items.filter((item) => nowMs < item.expiresAtMs);
}

export function getKillFeedEntryPhase(
  item: TrackedKillFeedItem,
  nowMs: number,
  exitMs: number = KILL_FEED_EXIT_MS,
): KillFeedEntryPhase {
  return nowMs >= item.expiresAtMs - exitMs ? 'exiting' : 'active';
}

/**
 * Returns milliseconds until the soonest item transitions into `'exiting'` or expires completely,
 * or null if the feed is empty. Allows single-timeout scheduling with zero idle polling.
 */
export function getNextKillFeedTransitionMs(
  items: readonly TrackedKillFeedItem[],
  nowMs: number,
  exitMs: number = KILL_FEED_EXIT_MS,
): number | null {
  if (items.length === 0) return null;
  let soonest = Infinity;
  for (const item of items) {
    const fadeAt = item.expiresAtMs - exitMs;
    const nextBoundary = nowMs < fadeAt ? fadeAt : item.expiresAtMs;
    if (nextBoundary < soonest) {
      soonest = nextBoundary;
    }
  }
  return Math.max(0, soonest - nowMs);
}

/**
 * Classifies an elimination/death entry relative to the local operative so the HUD
 * can highlight local eliminations, local deaths, and environmental hazard deaths.
 */
export function classifyKillFeedInvolvement(
  event: KillFeedEvent,
  localPlayerId: string,
  localCallsign?: string,
): KillFeedInvolvement {
  const isLocalVictim =
    (event.victimId !== undefined && event.victimId === localPlayerId) ||
    (event.victimId === undefined && Boolean(localCallsign) && event.victimName === localCallsign);

  if (isLocalVictim) {
    return 'local_death';
  }

  const isLocalAttacker =
    (event.attackerId !== undefined && event.attackerId !== null && event.attackerId === localPlayerId) ||
    (event.attackerId === undefined && !event.isHazard && Boolean(localCallsign) && event.attackerName === localCallsign);

  if (isLocalAttacker) {
    return 'local_elimination';
  }

  if (event.isHazard && event.attackerTeam === 'hazard') {
    return 'hazard_death';
  }

  return 'elimination';
}
