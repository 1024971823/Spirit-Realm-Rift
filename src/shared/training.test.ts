import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getNextIncompleteTrainingStep,
  isTrainingComplete,
  markTrainingStepComplete,
  normalizeTrainingProgress,
  TRAINING_STEP_ORDER,
} from './training.ts';

test('training progress tracks all 6 tactical drills idempotently and detects completion', () => {
  let progress = normalizeTrainingProgress(null);
  assert.equal(progress.completedSteps.length, 0);
  assert.equal(getNextIncompleteTrainingStep(progress), 'drive_dash');
  assert.equal(isTrainingComplete(progress), false);

  // Deduplicates invalid and repeated entries
  progress = normalizeTrainingProgress({
    completedSteps: ['drive_dash', 'drive_dash', 'unknown_step' as never],
  });
  assert.deepEqual(progress.completedSteps, ['drive_dash']);
  assert.equal(getNextIncompleteTrainingStep(progress), 'fire_vent');

  const completedAt = 1700000005000;
  for (const step of TRAINING_STEP_ORDER) {
    progress = markTrainingStepComplete(progress, step, completedAt);
  }
  assert.equal(isTrainingComplete(progress), true);
  assert.equal(getNextIncompleteTrainingStep(progress), null);
  assert.equal(progress.completedAllAt, completedAt);

  // Re-marking a completed step keeps original completion timestamp
  const again = markTrainingStepComplete(progress, 'tactical_ping', completedAt + 9999);
  assert.equal(again.completedAllAt, completedAt);
});
