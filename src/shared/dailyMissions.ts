import type {
  DailyMissionContribution,
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
