/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared constants for the OPT-IN Redis seam (audit D-14). Redis is enabled ONLY when
 * `REDIS_URL` is set; with it unset the app behaves exactly as before (no Redis client is created).
 */

/** DI token for the optional shared ioredis client (or `null` when `REDIS_URL` is unset). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/** Pub/sub channel the realtime SSE bridge fans dashboard events across instances over. */
export const REALTIME_CHANNEL = 'ftd:realtime:dashboard';

/** True iff the Redis seam is enabled (i.e. `REDIS_URL` is set and non-empty). */
export function isRedisEnabled(): boolean {
  return typeof process.env.REDIS_URL === 'string' && process.env.REDIS_URL.trim().length > 0;
}
