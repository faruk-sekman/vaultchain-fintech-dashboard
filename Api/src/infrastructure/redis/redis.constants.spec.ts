/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the OPT-IN Redis seam constants. The only executable logic here is
 * isRedisEnabled() (a real branch on REDIS_URL presence/emptiness) — redis.constants.ts is therefore
 * kept IN the unit coverage denominator (NOT excluded as a pure declaration). Hermetic: only
 * process.env.REDIS_URL is toggled and restored.
 */
import { REALTIME_CHANNEL, REDIS_CLIENT, isRedisEnabled } from './redis.constants';

describe('redis.constants', () => {
  const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

  afterEach(() => {
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  });

  it('exposes a unique DI token symbol and the realtime channel name', () => {
    expect(typeof REDIS_CLIENT).toBe('symbol');
    expect(REDIS_CLIENT.toString()).toContain('REDIS_CLIENT');
    expect(REALTIME_CHANNEL).toBe('ftd:realtime:dashboard');
  });

  it('isRedisEnabled() is false when REDIS_URL is unset', () => {
    delete process.env.REDIS_URL;
    expect(isRedisEnabled()).toBe(false);
  });

  it('isRedisEnabled() is false when REDIS_URL is empty or whitespace-only', () => {
    process.env.REDIS_URL = '';
    expect(isRedisEnabled()).toBe(false);
    process.env.REDIS_URL = '   ';
    expect(isRedisEnabled()).toBe(false);
  });

  it('isRedisEnabled() is true when REDIS_URL is a non-empty string', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    expect(isRedisEnabled()).toBe(true);
  });
});
