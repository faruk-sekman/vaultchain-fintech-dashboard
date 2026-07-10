/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the pure relative-time helper: the coarse buckets, the static i18n keys, the
 * absolute-fallback flag, and graceful handling of a future/invalid timestamp.
 */
import { describe, it, expect } from 'vitest';
import { relativeTime } from './relative-time.util';

const NOW = Date.parse('2026-06-29T12:00:00.000Z');

describe('relativeTime', () => {
  it('returns justNow for < 45s', () => {
    const r = relativeTime(new Date(NOW - 10_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.justNow');
    expect(r.absolute).toBe(false);
  });

  it('returns minutesAgo with a rounded count under an hour', () => {
    const r = relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.minutesAgo');
    expect(r.params).toEqual({ count: 5 });
  });

  it('returns hoursAgo with a floored count under a day', () => {
    const r = relativeTime(new Date(NOW - 3 * 3_600_000 - 30 * 60_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.hoursAgo');
    expect(r.params).toEqual({ count: 3 });
  });

  it('returns daysAgo with a floored count under a week', () => {
    const r = relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.daysAgo');
    expect(r.params).toEqual({ count: 2 });
  });

  it('flags absolute for >= 7 days (the caller renders the date)', () => {
    const r = relativeTime(new Date(NOW - 10 * 86_400_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.absolute');
    expect(r.absolute).toBe(true);
  });

  it('degrades a future timestamp to justNow (no negative count)', () => {
    const r = relativeTime(new Date(NOW + 60_000).toISOString(), NOW);
    expect(r.key).toBe('common.time.justNow');
  });

  it('degrades an invalid timestamp to justNow', () => {
    const r = relativeTime('not-a-date', NOW);
    expect(r.key).toBe('common.time.justNow');
    expect(r.absolute).toBe(false);
  });
});
