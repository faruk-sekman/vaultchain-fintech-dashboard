/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * OPT-IN Redis seam for horizontal-scale readiness (audit D-14).
 *
 * Behaviour is env-gated on `REDIS_URL`:
 *   - UNSET/empty → the `REDIS_CLIENT` token resolves to `null`. NO ioredis connection is opened;
 *     the throttler stays in-memory and the realtime bus stays a single-process Subject. The app and
 *     the entire test suite (no Redis in local/CI) behave EXACTLY as before.
 *   - set         → a single shared ioredis client is created for commands + publishing (subscribers
 *     get their own duplicated connection, per ioredis pub/sub rules). It is destroyed on shutdown.
 *
 * Connection failures never crash the process: `lazyConnect` + a bounded retry let consumers apply
 * their own policy. Realtime degrades to same-instance delivery; distributed throttling denies requests
 * until shared counters recover. No secrets are logged (only lifecycle, never the URL).
 */
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT, isRedisEnabled } from './redis.constants';

const logger = new Logger('RedisModule');

/** Build the shared command/publish client, or `null` when the seam is disabled. */
function createRedisClient(): Redis | null {
  if (!isRedisEnabled()) return null;
  // `REDIS_URL` is guaranteed present + non-empty here (isRedisEnabled).
  const client = new Redis(process.env.REDIS_URL as string, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
  // Never log the URL (it may carry credentials) — only the error message.
  client.on('error', (err: Error) => logger.warn(`Redis client error: ${err.message}`));
  // Connect eagerly-but-non-blocking; a failure here is logged, not thrown (app still boots).
  void client.connect().catch((err: unknown) => {
    logger.warn(`Redis initial connect failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  });
  return client;
}

const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: createRedisClient,
};

@Global()
@Module({
  providers: [redisClientProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  /** Close the shared socket on a graceful stop. No-op when the seam is disabled (client is null). */
  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
