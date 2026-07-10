/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the Redis-backed ThrottlerStorage (audit D-14). The Lua script runs
 * in Redis; here we mock `eval` and pin the OUTPUT mapping the @nestjs/throttler guard depends on
 * (the seconds rounding + isBlocked flag) and the namespaced key shape. The third block pins the
 * Redis-outage handling: a storage error returns a blocked decision so the distributed security budget
 * cannot silently split into fresh per-process counters.
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

  describe('Redis-error resilience (fail closed, never split the global budget)', () => {
    const makeFailingRedis = () => {
      const evalFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      return { redis: { eval: evalFn } as unknown as Redis, evalFn };
    };

    it('returns a blocked throttling decision when Redis is unreachable', async () => {
      const { redis } = makeFailingRedis();
      const storage = new RedisThrottlerStorage(redis);

      const record = await storage.increment('9.9.9.9', 60_000, 3, 60_000, 'default');

      expect(record.totalHits).toBe(4);
      expect(record.isBlocked).toBe(true);
      expect(record.timeToExpire).toBeGreaterThan(0);
      expect(record.timeToBlockExpire).toBeGreaterThan(0);
    });

    it('resumes the shared (Redis) path once Redis recovers', async () => {
      const evalFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED')) // outage
        .mockResolvedValueOnce([7, 30_000, 0, 0]); // recovered: live shared count
      const storage = new RedisThrottlerStorage({ eval: evalFn } as unknown as Redis);

      const degraded = await storage.increment('1.1.1.1', 60_000, 100, 60_000, 'default');
      expect(degraded.isBlocked).toBe(true);

      const recovered = await storage.increment('1.1.1.1', 60_000, 100, 60_000, 'default');
      expect(recovered.totalHits).toBe(7); // back to the shared Redis counter
    });

    it('fails closed even when the rejection is a NON-Error value', async () => {
      // ioredis can reject with a plain string/object on some transport failures; the warning's
      // `error instanceof Error ? error.message : 'unknown error'` non-Error branch must not crash and
      // the decision must still fail closed rather than throwing or allowing.
      const evalFn = jest.fn().mockRejectedValue('connection dropped'); // a string, not an Error
      const storage = new RedisThrottlerStorage({ eval: evalFn } as unknown as Redis);

      const first = await storage.increment('7.7.7.7', 60_000, 2, 60_000, 'default');
      expect(first.totalHits).toBe(3);
      expect(first.isBlocked).toBe(true);
    });
  });
});
