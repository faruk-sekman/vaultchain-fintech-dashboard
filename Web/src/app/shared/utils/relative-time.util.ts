/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Pure relative-time helper. Maps an ISO timestamp to a STATIC i18n key + params bag so
 * the rendered string is fully localizable AND `i18n:check` can see every key (no key is built from a
 * dynamic value). Coarse buckets — "just now", minutes, hours, days — are enough for a notification feed;
 * older items fall back to an absolute date the caller formats via the `DatePipe`. Tested in isolation.
 */

/** A relative-time result: a static i18n key and its interpolation params (empty for `justNow`/`absolute`). */
export interface RelativeTime {
  key: string;
  params: Record<string, number>;
  /** True when the caller should instead render the absolute `createdAt` via the DatePipe (>= 7 days). */
  absolute: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Bucket `iso` relative to `now` (default: the call time). Returns one of:
 *   < 45s            → `common.time.justNow`
 *   < 60m            → `common.time.minutesAgo` { count }
 *   < 24h            → `common.time.hoursAgo`   { count }
 *   < 7d             → `common.time.daysAgo`    { count }
 *   otherwise        → `absolute: true` (the caller renders the date).
 * A future/invalid timestamp degrades to `justNow` rather than a negative count.
 */
export function relativeTime(iso: string, now: number = Date.now()): RelativeTime {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { key: 'common.time.justNow', params: {}, absolute: false };

  const diff = now - then;
  if (diff < 45_000) return { key: 'common.time.justNow', params: {}, absolute: false };
  if (diff < HOUR) {
    return {
      key: 'common.time.minutesAgo',
      params: { count: Math.round(diff / MINUTE) },
      absolute: false,
    };
  }
  if (diff < DAY) {
    return {
      key: 'common.time.hoursAgo',
      params: { count: Math.floor(diff / HOUR) },
      absolute: false,
    };
  }
  if (diff < 7 * DAY) {
    return {
      key: 'common.time.daysAgo',
      params: { count: Math.floor(diff / DAY) },
      absolute: false,
    };
  }
  return { key: 'common.time.absolute', params: {}, absolute: true };
}
