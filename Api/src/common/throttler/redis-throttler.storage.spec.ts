/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the Redis-backed ThrottlerStorage (audit D-14). The Lua script runs
 * in Redis; here we mock `eval` and pin the OUTPUT mapping the @nestjs/throttler guard depends on
 * (the seconds rounding + isBlocked flag) and the namespaced key shape. The third block pins the
 * HARDENING-2 resilience: a Redis error degrades to per-instance in-memory enforcement (still returns
 * a throttling decision that increments + blocks at limit+1) instead of throwing or fail-open allowing.
 */
import type Redis from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  const makeRedis = (evalResult: [number, number, number, number]) => {
    const evalFn = jest.fn().mockResolvedValue(evalResult);
    return { redis: { eval: evalFn } as unknown as Redis, evalFn };
  };

  it('maps the Lua result (ms) to the throttler record (seconds, ceil) for an under-limit hit', async () => {
    const { redis, evalFn } = makeRedis([3, 45_000, 0, 0]);
    const storage = new RedisThrottlerStorage(redis);

    const record = await storage.increment('1.2.3.4', 60_000, 100, 60_000, 'default');

    expect(record).toEqual({ totalHits: 3, timeToExpire: 45, isBlocked: false, timeToBlockExpire: 0 });
    // Namespaced, throttler-scoped keys (hit key + its :blocked sibling) — no collision with other state.
    expect(evalFn).toHaveBeenCalledWith(
      expect.any(String),
      2,
      'ftd:throttle:default:1.2.3.4',
      'ftd:throttle:default:1.2.3.4:blocked',
      '60000',
      '100',
      '60000',
    );
  });

  it('reports isBlocked once the count exceeds the limit, ceiling sub-second windows', async () => {
    const { redis } = makeRedis([101, 59_400, 1, 59_400]);
    const storage = new RedisThrottlerStorage(redis);

    const record = await storage.increment('1.2.3.4', 60_000, 100, 60_000, 'default');

    expect(record).toEqual({ totalHits: 101, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 60 });
  });

  describe('HARDENING-2: Redis-error resilience (degrade to in-memory, never fail-open)', () => {
    const makeFailingRedis = () => {
      const evalFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      return { redis: { eval: evalFn } as unknown as Redis, evalFn };
    };

    it('returns a throttling decision (does NOT throw) when Redis is unreachable', async () => {
      const { redis } = makeFailingRedis();
      const storage = new RedisThrottlerStorage(redis);

      const record = await storage.increment('9.9.9.9', 60_000, 3, 60_000, 'default');

      expect(record.totalHits).toBe(1);
      expect(record.isBlocked).toBe(false);
      expect(record.timeToExpire).toBeGreaterThan(0);
    });

    it('keeps counting per-instance across the outage and BLOCKS at limit+1 (no fail-open allow)', async () => {
      const { redis, evalFn } = makeFailingRedis();
      const storage = new RedisThrottlerStorage(redis);
      const hit = () => storage.increment('9.9.9.9', 60_000, 3, 60_000, 'default');

      expect((await hit()).totalHits).toBe(1);
      expect((await hit()).totalHits).toBe(2);
      expect((await hit()).totalHits).toBe(3);
      const fourth = await hit();
      expect(fourth.totalHits).toBe(4); // limit is 3 → the 4th hit trips the block.
      expect(fourth.isBlocked).toBe(true);
      expect(fourth.timeToBlockExpire).toBeGreaterThan(0);
      // A subsequent hit while blocked does not count further but stays blocked.
      const fifth = await hit();
      expect(fifth.isBlocked).toBe(true);
      expect(fifth.totalHits).toBe(4);
      // Every call went through the (failing) Redis path first, then degraded.
      expect(evalFn).toHaveBeenCalledTimes(5);
    });

    it('isolates counters per key under degradation', async () => {
      const { redis } = makeFailingRedis();
      const storage = new RedisThrottlerStorage(redis);

      await storage.increment('a', 60_000, 5, 60_000, 'default');
      await storage.increment('a', 60_000, 5, 60_000, 'default');
      const b = await storage.increment('b', 60_000, 5, 60_000, 'default');

      expect(b.totalHits).toBe(1); // key 'b' is independent of key 'a'.
    });

    it('resumes the shared (Redis) path once Redis recovers', async () => {
      const evalFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // outage
        .mockResolvedValueOnce([7, 30_000, 0, 0]); // recovered: live shared count
      const storage = new RedisThrottlerStorage({ eval: evalFn } as unknown as Redis);

      const degraded = await storage.increment('1.1.1.1', 60_000, 100, 60_000, 'default');
      expect(degraded.totalHits).toBe(1); // local fallback

      const recovered = await storage.increment('1.1.1.1', 60_000, 100, 60_000, 'default');
      expect(recovered.totalHits).toBe(7); // back to the shared Redis counter
    });

    it('degrades (still enforces, logs once) even when the rejection is a NON-Error value', async () => {
      // ioredis can reject with a plain string/object on some transport failures; the warning's
      // `error instanceof Error ? error.message : 'unknown error'` non-Error branch must not crash and
      // the decision must still degrade to local enforcement (not fail-open).
      const evalFn = jest.fn().mockRejectedValue('connection dropped'); // a string, not an Error
      const storage = new RedisThrottlerStorage({ eval: evalFn } as unknown as Redis);

      const first = await storage.increment('7.7.7.7', 60_000, 2, 60_000, 'default');
      expect(first.totalHits).toBe(1);
      expect(first.isBlocked).toBe(false);

      // Still counts + blocks locally across the non-Error outage (the limit stays enforced).
      await storage.increment('7.7.7.7', 60_000, 2, 60_000, 'default');
      const third = await storage.increment('7.7.7.7', 60_000, 2, 60_000, 'default');
      expect(third.totalHits).toBe(3); // limit is 2 → the 3rd hit trips the block.
      expect(third.isBlocked).toBe(true);
    });
  });
});
