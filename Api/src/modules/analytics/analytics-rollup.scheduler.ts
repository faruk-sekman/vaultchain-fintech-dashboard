/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Daily metric_daily rollup (audit M5). The dashboard "Customer trend" (/metrics/daily) and the
 * analytics "Volume" chart read metric_daily; with no scheduled refresh those series freeze at seed
 * time in any real deployment. rollupDailyMetrics is idempotent (ON CONFLICT / replace), so a missed
 * or duplicate run is safe. A PostgreSQL advisory lock (below) makes exactly one instance run the
 * heavy aggregation in a multi-instance deployment; the others skip cleanly (re-audit
 * op-analytics-rollup-lock) — a cost optimisation, since idempotency already makes it correctness-safe.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Stable, namespaced advisory-lock key — ASCII "FTAR" (Fintech-Analytics-Rollup), distinct from the
 * notification-prune (FTNP) and audit-chain (424242) locks. `bigint` pins the int8 overload. */
export const ANALYTICS_ROLLUP_LOCK_KEY = 0x4654_4152n;

@Injectable()
export class AnalyticsRollupScheduler {
  private readonly logger = new Logger(AnalyticsRollupScheduler.name);

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runDailyRollup(): Promise<void> {
    let locked = false;
    try {
      // Single-runner gate: only the instance that wins the advisory lock runs the aggregation.
      const rows = await this.prisma.$queryRaw<
        Array<{ locked: boolean }>
      >`SELECT pg_try_advisory_lock(${ANALYTICS_ROLLUP_LOCK_KEY}::bigint) AS locked`;
      locked = rows[0]?.locked === true;
      if (!locked) {
        this.logger.debug('another instance holds the rollup lock; skipping');
        return;
      }
      await this.analytics.rollupDailyMetrics();
      this.logger.log('Daily metric rollup complete.');
    } catch (error) {
      // Never let a failed rollup crash the scheduler/app — log and let the next run retry.
      this.logger.error(
        'Daily metric rollup failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (locked) {
        try {
          await this.prisma.$executeRaw`SELECT pg_advisory_unlock(${ANALYTICS_ROLLUP_LOCK_KEY}::bigint)`;
        } catch (unlockError) {
          this.logger.error(
            'Daily metric rollup lock release failed',
            unlockError instanceof Error ? unlockError.stack : String(unlockError),
          );
        }
      }
    }
  }
}
