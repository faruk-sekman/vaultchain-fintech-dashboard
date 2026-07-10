/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Thin Redis-backed `ThrottlerStorage` (audit D-14) so per-IP rate-limit counters are
 * SHARED across instances behind a load balancer — closing the horizontal-scale gap of the default
 * in-process Map storage (which would let N instances each grant the full limit).
 *
 * Used ONLY when `REDIS_URL` is set; with it unset the app keeps the built-in in-memory storage and
 * this class is never constructed (see app.module ThrottlerModule.forRootAsync).
 *
 * Atomicity: a single Lua script does increment + TTL + block-window bookkeeping per request, so two
 * concurrent requests on different instances can never both read-then-write a stale count. The script
 * mirrors @nestjs/throttler's in-memory `ThrottlerStorageService.increment` contract: it returns
 * `{ totalHits, timeToExpire, isBlocked, timeToBlockExpire }` with the same blockDuration semantics.
 *
 * Resilience (HARDENING-2, sec-review / fail-closed): if Redis is unreachable the Lua `eval`
 * rejects, and NestJS `ThrottlerGuard` treats a storage error as ALLOW — silently DISABLING the rate
 * limit exactly when a shared limiter matters most. A local fallback would split the security budget
 * across instances and reset it on every process, so an `increment()` Redis error instead returns a
 * blocked decision. This intentionally trades availability for preserving the configured global abuse
 * boundary; deployments that do not require Redis can leave REDIS_URL unset and use Nest's local store.
 */
import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';

// KEYS[1] = hit-count key, KEYS[2] = block key.
// ARGV[1] = ttl(ms), ARGV[2] = limit, ARGV[3] = blockDuration(ms).
// Returns: { totalHits, timeToExpireMs, isBlocked(0/1), timeToBlockExpireMs }.
const INCREMENT_LUA = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  -- Currently blocked: report the live count + remaining block window; do not count the hit.
  local hits = tonumber(redis.call('GET', hitKey) or '0')
  local hitPttl = redis.call('PTTL', hitKey)
  if hitPttl < 0 then hitPttl = ttl end
  return { hits, hitPttl, 1, blockPttl }
end

local totalHits = redis.call('INCR', hitKey)
if totalHits == 1 then
  redis.call('PEXPIRE', hitKey, ttl)
end
local hitPttl = redis.call('PTTL', hitKey)
if hitPttl < 0 then
  redis.call('PEXPIRE', hitKey, ttl)
  hitPttl = ttl
end

local isBlocked = 0
local timeToBlockExpire = 0
if totalHits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  isBlocked = 1
  timeToBlockExpire = blockDuration
end

return { totalHits, hitPttl, isBlocked, timeToBlockExpire }
`;

/** Namespace so throttler keys never collide with other Redis state (realtime, future caches). */
const KEY_PREFIX = 'ftd:throttle';

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  /** One-shot guard so a Redis outage logs a single fail-closed warning, not one per request. */
  private degraded = false;

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `${KEY_PREFIX}:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    try {
      // ioredis `eval` returns the Lua table as a JS array of numbers.
      const result = (await this.redis.eval(
        INCREMENT_LUA,
        2,
        hitKey,
        blockKey,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number, number];

      // Redis is healthy again — clear the degraded flag so a later outage re-logs once.
      if (this.degraded) {
        this.degraded = false;
        this.logger.log('Redis throttler storage recovered; resumed shared rate-limit counters.');
      }
      const [totalHits, timeToExpireMs, isBlockedFlag, timeToBlockExpireMs] = result;
      return this.toRecord(totalHits, timeToExpireMs, isBlockedFlag === 1, timeToBlockExpireMs);
    } catch (error) {
      // Fail closed. Falling back to a fresh per-process Map would multiply the effective budget by
      // instance count and let restarts reset it, which breaks the distributed security invariant.
      if (!this.degraded) {
        this.degraded = true;
        // No secrets: only the error message, never the Redis URL.
        this.logger.warn(
          `Redis throttler storage unreachable; denying throttled requests until shared counters recover. ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
      const denyFor = Math.max(ttl, blockDuration, 1_000);
      return this.toRecord(limit + 1, denyFor, true, denyFor);
    }
  }

  /** Build the throttler record, converting ms windows to ceil-seconds (matches in-memory storage). */
  private toRecord(
    totalHits: number,
    timeToExpireMs: number,
    isBlocked: boolean,
    timeToBlockExpireMs: number,
  ): ThrottlerStorageRecord {
    return {
      totalHits,
      // @nestjs/throttler reports timeToExpire/timeToBlockExpire in SECONDS (the in-memory storage
      // ceils ms→s); match that so the `Retry-After` header is identical between storages.
      timeToExpire: Math.ceil(timeToExpireMs / 1000),
      isBlocked,
      timeToBlockExpire: Math.ceil(Math.max(0, timeToBlockExpireMs) / 1000),
    };
  }
}
