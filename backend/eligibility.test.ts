import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minorWindowEnd, permitted, restrictEligibility } from './eligibility.ts';

test('Beijing time controls weekend and statutory holiday play', () => {
  const holidays = new Set(['2026-11-23']);
  const friday = Date.parse('2026-11-20T20:00:00+08:00');
  assert.equal(minorWindowEnd(friday - 1, holidays), undefined);
  assert.equal(minorWindowEnd(friday, holidays), friday + 3_600_000);
  assert.equal(minorWindowEnd(friday + 3_600_000, holidays), undefined);
  assert.equal(minorWindowEnd(Date.parse('2026-11-23T20:00:00+08:00'), holidays), Date.parse('2026-11-23T21:00:00+08:00'));
  assert.equal(minorWindowEnd(Date.parse('2026-11-24T20:00:00+08:00'), holidays), undefined);
});

test('a minor can resume during the window but cannot start too late', () => {
  const minor = { kind: 'minor', permittedUntil: 200_000 } as const;
  assert.equal(permitted(minor, 20_000, 180_000), true);
  assert.equal(permitted(minor, 20_001, 180_000), false);
  assert.equal(permitted(minor, 199_999), true);
  assert.equal(permitted(minor, 200_000), false);
  assert.equal(permitted({ kind: 'denied' }, 20_000), false);
});

test('provider eligibility is bounded by the server calendar and deadline', () => {
  const holidays = new Set<string>();
  const now = Date.parse('2026-11-20T20:30:00+08:00');
  const end = Date.parse('2026-11-20T21:00:00+08:00');
  assert.deepEqual(restrictEligibility({ kind: 'minor', permittedUntil: end + 86_400_000 }, now, holidays), { kind: 'minor', permittedUntil: end });
  assert.deepEqual(restrictEligibility({ kind: 'minor', permittedUntil: now + 60_000 }, now, holidays), { kind: 'minor', permittedUntil: now + 60_000 });
  assert.deepEqual(restrictEligibility({ kind: 'minor', permittedUntil: end + 86_400_000 }, end, holidays), { kind: 'denied' });
  for (const value of [null, {}, { kind: 'minor' }, { kind: 'minor', permittedUntil: Infinity }, { kind: 'minor', permittedUntil: String(end) }]) {
    assert.deepEqual(restrictEligibility(value, now, holidays), { kind: 'denied' });
  }
});
