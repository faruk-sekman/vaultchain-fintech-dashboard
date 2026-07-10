/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Notification retention prune. Runs daily to enforce the retention policy (delete rows
 * older than 90 days OR beyond the newest 200 per recipient — see NotificationService.prune). The prune
 * is idempotent and best-effort: a failure is logged and the next run retries; it never crashes the app.
 *
 * MULTI-INSTANCE SAFETY: with several API instances the @Cron fires once PER instance, so every instance
 * would prune concurrently. We gate the run behind a PostgreSQL SESSION-LEVEL advisory lock
 * (pg_try_advisory_lock): exactly one instance acquires it and prunes; the others get `false` and skip
 * cleanly. The lock is non-blocking (try, never wait) and is always released in `finally`
 * (pg_advisory_unlock). This needs no new dependency — it is pure SQL via Prisma.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationService } from './notification.service';

/**
 * Stable, namespaced advisory-lock key for the notification retention prune. Advisory locks share one
 * global int8 keyspace per database, so the constant must be FIXED (same value on every instance, every
 * deploy) and distinct from other advisory locks. Chosen as the ASCII bytes of "FTNP"
 * (Fintech-Notification-Prune) = 0x4654_4e50 = 1_180_525_392 — a deterministic, self-documenting value
 * that does not collide with the audit chain lock (AUDIT_LOCK_KEY = 424242). `bigint` pins the int8
 * (single-argument) pg_try_advisory_lock overload.
 */
export const NOTIFICATION_PRUNE_LOCK_KEY = 0x4654_4e50n;

@Injectable()
export class NotificationPruneScheduler {
  private readonly logger = new Logger(NotificationPruneScheduler.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async runRetentionPrune(): Promise<void> {
    let locked = false;
    try {
      // Single-runner gate: only the instance that wins the advisory lock prunes; others skip.
      const rows = await this.prisma.$queryRaw<
        Array<{ locked: boolean }>
      >`SELECT pg_try_advisory_lock(${NOTIFICATION_PRUNE_LOCK_KEY}::bigint) AS locked`;
      locked = rows[0]?.locked === true;

      if (!locked) {
        this.logger.debug('another instance holds the prune lock; skipping');
        return;
      }

      await this.notifications.prune();
    } catch (error) {
      this.logger.error(
        'Notification retention prune failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      // Only unlock what we actually acquired, and never let a release error escape the scheduler.
      if (locked) {
        try {
          await this.prisma
            .$executeRaw`SELECT pg_advisory_unlock(${NOTIFICATION_PRUNE_LOCK_KEY}::bigint)`;
        } catch (unlockError) {
          this.logger.error(
            'Notification retention prune lock release failed',
            unlockError instanceof Error ? unlockError.stack : String(unlockError),
          );
        }
      }
    }
  }
}
