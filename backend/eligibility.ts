export type Eligibility = { kind: 'adult' } | { kind: 'minor'; permittedUntil: number } | { kind: 'denied' };

export function minorWindowEnd(now: number, holidays: ReadonlySet<string>): number | undefined {
  const local = new Date(now + 8 * 3_600_000);
  const day = local.getUTCDay();
  const date = local.toISOString().slice(0, 10);
  if (local.getUTCHours() !== 20 || (![0, 5, 6].includes(day) && !holidays.has(date))) return;
  return Date.parse(date + 'T21:00:00+08:00');
}

export function permitted(result: Eligibility, now: number, minDurationMs = 0): boolean {
  return result.kind === 'adult' || (result.kind === 'minor' && now < result.permittedUntil && now + minDurationMs <= result.permittedUntil);
}

export function restrictEligibility(value: unknown, now: number, holidays: ReadonlySet<string>): Eligibility {
  if (!value || typeof value !== 'object') return { kind: 'denied' };
  const result = value as Partial<{ kind: string; permittedUntil: number }>;
  if (result.kind === 'adult') return { kind: 'adult' };
  if (result.kind !== 'minor' || !Number.isFinite(result.permittedUntil)) return { kind: 'denied' };
  const localEnd = minorWindowEnd(now, holidays);
  const permittedUntil = Math.min(localEnd ?? 0, result.permittedUntil!);
  return now < permittedUntil ? { kind: 'minor', permittedUntil } : { kind: 'denied' };
}
