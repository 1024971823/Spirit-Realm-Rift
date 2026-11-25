import type {
  DailyMissionContribution,
  DailyMissionEligibilityPolicy,
  DailyMissionIneligibleReason,
  DailyMissionObjectiveKind,
  DailyMissionProgress,
  DailyMissionsState,
  DailyMissionSummaryUpdate,
  RobotClass,
} from './types.ts';

export interface DailyMissionTemplate {
  templateId: string;
  slot: 'combat' | 'victory' | 'tactical';
  kind: DailyMissionObjectiveKind;
  robotClass?: RobotClass;
  target: number;
  rewardCredits: number;
}

export const DAILY_MISSION_ALL_CLEAR_BONUS = 200;

export const DAILY_MISSION_TEMPLATES: readonly DailyMissionTemplate[] = [
  // Slot 1: Combat / Robot-specific eliminations (S1 Striker only — EP Engineer is unarmed by design)
  {
    templateId: 's1_kills_5',
    slot: 'combat',
    kind: 'kills_with_robot',
    robotClass: 's1_striker',
    target: 5,
    rewardCredits: 150,
  },
  {
    templateId: 's1_kills_8',
    slot: 'combat',
    kind: 'kills_with_robot',
    robotClass: 's1_striker',
    target: 8,
    rewardCredits: 220,
  },
  // Slot 2: Victory / Match cadence
  {
    templateId: 'win_2_matches',
    slot: 'victory',
    kind: 'win_matches',
    target: 2,
    rewardCredits: 200,
  },
  {
    templateId: 'play_3_matches',
    slot: 'victory',
    kind: 'play_matches',
    target: 3,
    rewardCredits: 140,
  },
  // Slot 3: Tactical / Support & Arena objectives (including unarmed EP Engineer ore mining)
  {
    templateId: 'ep_mine_250',
    slot: 'tactical',
    kind: 'mine_ore_with_robot',
    robotClass: 'ep_miner',
    target: 250,
    rewardCredits: 160,
  },
  {
    templateId: 'deal_damage_600',
    slot: 'tactical',
    kind: 'deal_damage',
    target: 600,
    rewardCredits: 150,
  },
  {
    templateId: 'destroy_barriers_3',
    slot: 'tactical',
    kind: 'destroy_barriers',
    target: 3,
    rewardCredits: 140,
  },
  {
    templateId: 'ep_repair_150',
    slot: 'tactical',
    kind: 'ally_repair',
    robotClass: 'ep_miner',
    target: 150,
    rewardCredits: 170,
  },
];

const TEMPLATE_BY_ID = new Map<string, DailyMissionTemplate>(
  DAILY_MISSION_TEMPLATES.map(tpl => [tpl.templateId, tpl]),
);

const SLOTS: readonly DailyMissionTemplate['slot'][] = ['combat', 'victory', 'tactical'];

export function getUtcDayKey(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function msUntilNextUtcDay(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(0, nextMidnight - nowMs);
}

export function computeServerResetDeadline(
  nextResetMs: number,
  clientNowMs = Date.now(),
): number {
  const safeMs = Number.isFinite(nextResetMs) ? Math.max(0, Math.floor(nextResetMs)) : 0;
  return clientNowMs + safeMs;
}

export function shouldRefreshDailyMissions(
  deadlineMs: number,
  clientNowMs = Date.now(),
): boolean {
  return clientNowMs >= deadlineMs;
}

export interface MissionEligibilityInput {
  isPublicMatch: boolean;
  cancelled: boolean;
  forfeited: boolean;
  elapsedSec: number;
  reachedScoreLimit: boolean;
  damageDealt: number;
  oreMined: number;
  barriersDestroyed: number;
  allyRepair: number;
  coreControlSec: number;
  kills: number;
  policy: DailyMissionEligibilityPolicy;
}

export function evaluateDailyMissionEligibility(
  input: MissionEligibilityInput,
): { eligible: true } | { eligible: false; reason: DailyMissionIneligibleReason } {
  if (input.cancelled) return { eligible: false, reason: 'cancelled' };
  if (input.forfeited) return { eligible: false, reason: 'forfeited' };
  if (input.policy.publicOnly && !input.isPublicMatch) {
    return { eligible: false, reason: 'private_room_ineligible' };
  }
  if (!input.reachedScoreLimit && input.elapsedSec < input.policy.minMatchSec) {
    return { eligible: false, reason: 'match_too_short' };
  }
  const hasParticipation =
    input.kills > 0 ||
    input.damageDealt >= 20 ||
    input.oreMined >= 15 ||
    input.barriersDestroyed > 0 ||
    input.allyRepair >= 15 ||
    input.coreControlSec >= 3;
  if (!hasParticipation) {
    return { eligible: false, reason: 'inactive_participant' };
  }
  return { eligible: true };
}

function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function buildDailyMissionsForDay(dayKey: string, playerId: string): DailyMissionsState {
  const missions: DailyMissionProgress[] = SLOTS.map((slot, idx) => {
    const pool = DAILY_MISSION_TEMPLATES.filter(t => t.slot === slot);
    const seed = hashSeed(`${dayKey}:${playerId}:${slot}:${idx}`);
    const picked = pool[seed % pool.length];
    return {
      id: `${dayKey}:${picked.templateId}`,
      templateId: picked.templateId,
      kind: picked.kind,
      ...(picked.robotClass ? { robotClass: picked.robotClass } : {}),
      target: picked.target,
      progress: 0,
      rewardCredits: picked.rewardCredits,
    };
  });
  return { dayKey, missions };
}

export function normalizeDailyMissions(
  raw: Partial<DailyMissionsState> | null | undefined,
  playerId: string,
  nowMs = Date.now(),
): DailyMissionsState {
  const today = getUtcDayKey(nowMs);
  const fresh = buildDailyMissionsForDay(today, playerId);
  if (!raw || raw.dayKey !== today || !Array.isArray(raw.missions) || raw.missions.length === 0) {
    return fresh;
  }

  const rawById = new Map<string, Partial<DailyMissionProgress>>();
  for (const item of raw.missions) {
    if (item && typeof item.templateId === 'string') {
      rawById.set(item.templateId, item);
    }
  }

  const missions: DailyMissionProgress[] = fresh.missions.map(base => {
    const saved = rawById.get(base.templateId);
    if (!saved || !TEMPLATE_BY_ID.has(base.templateId)) return base;
    const rawProgress = Number(saved.progress);
    const progress = Number.isFinite(rawProgress)
      ? Math.max(0, Math.min(base.target, Math.floor(rawProgress)))
      : 0;
    const completedAt =
      progress >= base.target
        ? typeof saved.completedAt === 'number' && Number.isFinite(saved.completedAt)
          ? saved.completedAt
          : nowMs
        : undefined;
    const claimedAt =
      completedAt !== undefined && typeof saved.claimedAt === 'number' && Number.isFinite(saved.claimedAt)
        ? saved.claimedAt
        : undefined;
    return {
      ...base,
      progress,
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(claimedAt !== undefined ? { claimedAt } : {}),
    };
  });

  const allCompleted = missions.every(m => m.progress >= m.target);
  const allClearClaimedAt =
    allCompleted && typeof raw.allClearClaimedAt === 'number' && Number.isFinite(raw.allClearClaimedAt)
      ? raw.allClearClaimedAt
      : undefined;

  return {
    dayKey: today,
    missions,
    ...(allClearClaimedAt !== undefined ? { allClearClaimedAt } : {}),
  };
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates server-authoritative daily mission state without checking against
 * the local machine's UTC date, preventing client clock skew from zeroing progress.
 */
export function sanitizeServerDailyMissions(
  raw: Partial<DailyMissionsState> | null | undefined,
  playerId: string,
): DailyMissionsState {
  if (raw && typeof raw.dayKey === 'string' && DAY_KEY_PATTERN.test(raw.dayKey) && Array.isArray(raw.missions) && raw.missions.length > 0) {
    const baseMs = Date.parse(`${raw.dayKey}T12:00:00Z`);
    if (Number.isFinite(baseMs)) {
      return normalizeDailyMissions(raw, playerId, baseMs);
    }
  }
  return normalizeDailyMissions(raw, playerId);
}

function getContributionDelta(mission: DailyMissionProgress, contribution: DailyMissionContribution): number {
  switch (mission.kind) {
    case 'kills_with_robot': {
      if (!mission.robotClass) return 0;
      return Math.max(0, Math.floor(contribution.killsByRobot[mission.robotClass] ?? 0));
    }
    case 'mine_ore_with_robot': {
      if (!mission.robotClass) return 0;
      return Math.max(0, Math.floor(contribution.oreMinedByRobot[mission.robotClass] ?? 0));
    }
    case 'win_matches':
      return contribution.won ? 1 : 0;
    case 'play_matches':
      return Math.max(0, Math.floor(contribution.matchesCompleted));
    case 'deal_damage':
      return Math.max(0, Math.floor(contribution.damageDealt));
    case 'destroy_barriers':
      return Math.max(0, Math.floor(contribution.barriersDestroyed));
    case 'ally_repair':
      return Math.max(0, Math.floor(contribution.allyRepair ?? 0));
  }
}

export function applyMatchContributionToDailyMissions(
  current: Partial<DailyMissionsState> | null | undefined,
  playerId: string,
  contribution: DailyMissionContribution,
  nowMs = Date.now(),
): { state: DailyMissionsState; updates: DailyMissionSummaryUpdate[] } {
  const normalized = normalizeDailyMissions(current, playerId, nowMs);
  const updates: DailyMissionSummaryUpdate[] = [];
  const nextMissions = normalized.missions.map(mission => {
    const delta = getContributionDelta(mission, contribution);
    if (delta <= 0 || mission.progress >= mission.target) return mission;
    const before = mission.progress;
    const after = Math.min(mission.target, before + delta);
    const newlyCompleted = before < mission.target && after >= mission.target;
    updates.push({
      id: mission.id,
      templateId: mission.templateId,
      kind: mission.kind,
      ...(mission.robotClass ? { robotClass: mission.robotClass } : {}),
      before,
      after,
      target: mission.target,
      rewardCredits: mission.rewardCredits,
      newlyCompleted,
    });
    return {
      ...mission,
      progress: after,
      ...(newlyCompleted ? { completedAt: nowMs } : {}),
    };
  });

  return {
    state: { ...normalized, missions: nextMissions },
    updates,
  };
}

export type MissionClaimResult =
  | { ok: true; state: DailyMissionsState; creditsAwarded: number }
  | { ok: false; reason: 'not_found' | 'not_completed' | 'already_claimed' };

export function claimDailyMission(
  current: Partial<DailyMissionsState> | null | undefined,
  playerId: string,
  missionId: string,
  nowMs = Date.now(),
): MissionClaimResult {
  const state = normalizeDailyMissions(current, playerId, nowMs);
  const index = state.missions.findIndex(m => m.id === missionId);
  if (index === -1) return { ok: false, reason: 'not_found' };
  const target = state.missions[index];
  if (target.progress < target.target) return { ok: false, reason: 'not_completed' };
  if (target.claimedAt !== undefined) return { ok: false, reason: 'already_claimed' };
  const nextMissions = state.missions.map((m, i) =>
    i === index ? { ...m, completedAt: m.completedAt ?? nowMs, claimedAt: nowMs } : m,
  );
  return {
    ok: true,
    state: { ...state, missions: nextMissions },
    creditsAwarded: target.rewardCredits,
  };
}

export function claimAllClearBonus(
  current: Partial<DailyMissionsState> | null | undefined,
  playerId: string,
  nowMs = Date.now(),
): MissionClaimResult {
  const state = normalizeDailyMissions(current, playerId, nowMs);
  const allCompleted = state.missions.length > 0 && state.missions.every(m => m.progress >= m.target);
  if (!allCompleted) return { ok: false, reason: 'not_completed' };
  if (state.allClearClaimedAt !== undefined) return { ok: false, reason: 'already_claimed' };
  return {
    ok: true,
    state: { ...state, allClearClaimedAt: nowMs },
    creditsAwarded: DAILY_MISSION_ALL_CLEAR_BONUS,
  };
}

export function countClaimableDailyRewards(state: DailyMissionsState | null | undefined): number {
  if (!state) return 0;
  let count = 0;
  let allCompleted = state.missions.length > 0;
  for (const m of state.missions) {
    if (m.progress >= m.target) {
      if (m.claimedAt === undefined) count += 1;
    } else {
      allCompleted = false;
    }
  }
  if (allCompleted && state.allClearClaimedAt === undefined) count += 1;
  return count;
}
