export type TrainingStepId =
  | 'drive_dash'
  | 'fire_vent'
  | 'switch_chassis'
  | 'mine_repair'
  | 'team_resupply'
  | 'tactical_ping';

export const TRAINING_STEP_ORDER: readonly TrainingStepId[] = [
  'drive_dash',
  'fire_vent',
  'switch_chassis',
  'mine_repair',
  'team_resupply',
  'tactical_ping',
] as const;

export interface TrainingProgress {
  completedSteps: TrainingStepId[];
  completedAllAt?: number;
}

export function normalizeTrainingProgress(raw: unknown): TrainingProgress {
  const valid = new Set<TrainingStepId>(TRAINING_STEP_ORDER);
  if (!raw || typeof raw !== 'object') {
    return { completedSteps: [] };
  }
  const src = raw as Partial<TrainingProgress>;
  const unique: TrainingStepId[] = [];
  if (Array.isArray(src.completedSteps)) {
    for (const item of src.completedSteps) {
      if (typeof item === 'string' && valid.has(item as TrainingStepId) && !unique.includes(item as TrainingStepId)) {
        unique.push(item as TrainingStepId);
      }
    }
  }
  const allDone = unique.length === TRAINING_STEP_ORDER.length;
  return {
    completedSteps: unique,
    ...(allDone && typeof src.completedAllAt === 'number' && Number.isFinite(src.completedAllAt)
      ? { completedAllAt: src.completedAllAt }
      : {}),
  };
}

export function markTrainingStepComplete(
  current: TrainingProgress,
  step: TrainingStepId,
  nowMs = Date.now(),
): TrainingProgress {
  const norm = normalizeTrainingProgress(current);
  const completedSteps = norm.completedSteps.includes(step)
    ? norm.completedSteps
    : [...norm.completedSteps, step];
  const allDone = completedSteps.length === TRAINING_STEP_ORDER.length;
  return {
    completedSteps,
    ...(allDone ? { completedAllAt: norm.completedAllAt ?? nowMs } : {}),
  };
}

export function getNextIncompleteTrainingStep(progress: TrainingProgress): TrainingStepId | null {
  for (const step of TRAINING_STEP_ORDER) {
    if (!progress.completedSteps.includes(step)) return step;
  }
  return null;
}

export function isTrainingComplete(progress: TrainingProgress): boolean {
  return TRAINING_STEP_ORDER.every(step => progress.completedSteps.includes(step));
}
