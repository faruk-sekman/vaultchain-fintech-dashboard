/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Notification domain service. Owns a REAL, per-recipient notification table with true
 * read-state — replacing the audit-log-derived feed. RESPONSIBILITIES:
 *
 *  1. emit() — write one recipient-scoped notification, then publish a RECIPIENT-SCOPED `notification.
 *     created` SSE event so only that recipient's stream updates live. SEPARATE from audit: emit() does
 *     NOT touch AuditService (the audit log stays the single tamper-evident trail; emit ≠ audit). The
 *     paramsJson forbidden-field guard runs FIRST (fail-closed) so no PII/secret is ever persisted or
 *     emitted. Idempotent via an optional `dedupeKey`: a repeat emit with the same (recipient, type,
 *     resourceId, titleKey) within a short window is a no-op (prevents double rows on a retried event).
 *
 *  2. emitToOperatorsWithPreference() — fan a customer/KYC/product event out to every operator whose
 *     OperatorSettings toggle is on (preference mapping, plan §3.6). Security events do NOT use this —
 *     they target a specific recipient and ignore the preference (always delivered).
 *
 *  3. list()/markRead()/markAll() — ALL recipient-scoped from the authenticated subject. A user can
 *     only see/mark their OWN; mark-read on someone else's id affects 0 rows → 404 (never 200).
 *
 *  4. prune() — retention: delete rows older than the window OR beyond the per-recipient cap.
 *
 * Security boundary note: recipient-scoping here is enforced by the WHERE clause on every query; the SSE
 * scoping is enforced server-side in RealtimeService.scopedStream (see realtime.controller). FE filtering
 * is NOT a security control.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type NotificationSeverity, type NotificationType } from '@prisma/client';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  NotificationItemDto,
  PaginatedNotificationListDto,
} from './dto/notification.dto';
import { assertSafeNotificationParams } from './notification.params-guard';
import { parseNotificationListQuery } from './notification-list.query';

/** Retention: keep at most this many days of history per recipient. */
export const NOTIFICATION_RETENTION_DAYS = 90;
/** Retention: also keep at most this many rows per recipient (whichever prunes more). */
export const NOTIFICATION_RETENTION_MAX_PER_RECIPIENT = 200;
/** Idempotency window for a deduped emit (a retried domain event within this window is a no-op). */
const EMIT_DEDUPE_WINDOW_MS = 60_000;

/**
 * OperatorSettings preference toggles that gate fan-out (plan §3.6 mapping). `securityAlerts` →
 * security/account events (NOTE: security events are usually targeted + always delivered, so this maps
 * a BROADCAST security advisory only); `productUpdates` → customer/KYC/product events; `weeklyDigest`
 * → digest/system roll-ups. The enum members chosen at the call site stay the source of truth for
 * `type`; this only decides WHO receives a fanned-out event.
 */
export type OperatorPreferenceKey = 'securityAlerts' | 'productUpdates' | 'weeklyDigest';

/** Internal emit input — domain code calls this, never the HTTP layer. */
export interface EmitNotificationInput {
  recipientUserId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  titleKey: string;
  bodyKey: string;
  params?: Record<string, unknown> | null;
  resourceType: string;
  resourceId?: string | null;
  /**
   * Optional idempotency discriminator. When set, a second emit matching the same (recipient, type,
   * resourceId, titleKey) inside the dedupe window is skipped (returns the existing row). Used by
   * retry-prone callers (e.g. a security event that might double-fire). It is matched on existing
   * columns — NOT persisted as a field — so nothing extra leaks into the row.
   */
  dedupeKey?: string;
}

/** Fan-out input: same content for every recipient, minus the recipient (resolved by preference). */
export type FanOutNotificationInput = Omit<EmitNotificationInput, 'recipientUserId'>;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Create a recipient-scoped notification and publish a recipient-scoped `notification.created` SSE
   * event. Returns the created (or, when deduped, the pre-existing) notification id. Never throws on a
   * benign duplicate; DOES throw `Notification.ForbiddenParam` if params carry PII/secret (fail-closed).
   */
  async emit(input: EmitNotificationInput): Promise<{ id: string; deduped: boolean }> {
    // 1) Guard params BEFORE any write/emit — fail-closed on PII/secret.
    assertSafeNotificationParams(input.params ?? null);

    // 2) Idempotency: skip a recent duplicate for the same (recipient, type, resourceId, titleKey).
    if (input.dedupeKey) {
      const since = new Date(Date.now() - EMIT_DEDUPE_WINDOW_MS);
      const existing = await this.prisma.notification.findFirst({
        where: {
          recipientUserId: input.recipientUserId,
          type: input.type,
          resourceId: input.resourceId ?? null,
          titleKey: input.titleKey,
          createdAt: { gte: since },
        },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return { id: existing.id, deduped: true };
    }

    const id = uuidv7();
    await this.prisma.notification.create({
      data: {
        id,
        recipientUserId: input.recipientUserId,
        type: input.type,
        severity: input.severity,
        titleKey: input.titleKey,
        bodyKey: input.bodyKey,
        paramsJson: (input.params ?? undefined) as Prisma.InputJsonValue | undefined,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
      },
    });

    // 3) RECIPIENT-SCOPED SSE: only this recipient's stream receives it (server-side filter).
    this.realtime.emit('notification.created', id, { recipientUserId: input.recipientUserId });
    return { id, deduped: false };
  }

  /**
   * Fan a customer/KYC/product event out to every operator whose OperatorSettings `preference` toggle
   * is ON (the preference mapping, plan §3.6). Each recipient gets their OWN row + their OWN
   * recipient-scoped SSE event. `excludeUserId` skips the actor (don't notify the operator who caused
   * the change). Best-effort per recipient: one bad emit is logged and does not abort the rest. Returns
   * the number of recipients notified. Security events do NOT use this path (they target a specific
   * recipient and ignore the preference).
   */
  async emitToOperatorsWithPreference(
    preference: OperatorPreferenceKey,
    input: FanOutNotificationInput,
    options: { excludeUserId?: string } = {},
  ): Promise<number> {
    // Guard once up front — the content is identical for every recipient (fail-closed before fan-out).
    assertSafeNotificationParams(input.params ?? null);

    // Recipients = users whose settings row has the toggle on. Absent rows fall back to the column
    // default (productUpdates/securityAlerts default true, weeklyDigest false) — mirror that here so an
    // operator who never opened Settings still gets the on-by-default classes.
    const settings = await this.prisma.operatorSettings.findMany({
      where: { [preference]: true },
      select: { userId: true },
    });
    const optedIn = new Set(settings.map((s) => s.userId));

    if (preference !== 'weeklyDigest') {
      // On-by-default class: include users with NO settings row (default true).
      const withoutRow = await this.prisma.user.findMany({
        where: { operatorSettings: { is: null }, status: 'ACTIVE' },
        select: { id: true },
      });
      for (const u of withoutRow) optedIn.add(u.id);
    }

    optedIn.delete(options.excludeUserId ?? '');

    let notified = 0;
    for (const recipientUserId of optedIn) {
      try {
        await this.emit({ ...input, recipientUserId });
        notified += 1;
      } catch (error) {
        this.logger.warn(
          `Fan-out emit to ${recipientUserId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return notified;
  }

  /**
   * A15: fan a security/governance event out to every ACTIVE user holding `permissionCode` through any
   * of their roles (e.g. every `auth.password.admin_reset` holder when a reset request lands). Mirrors
   * emitToOperatorsWithPreference — params guarded ONCE up front (fail-closed before any write), each
   * recipient gets their OWN row + recipient-scoped SSE event, best-effort per recipient (one bad emit
   * is logged and never aborts the rest), `excludeUserId` skips the actor. Returns the number notified.
   * Unlike the preference fan-out there is NO default-on backfill: permission grants are explicit.
   */
  async emitToPermissionHolders(
    permissionCode: string,
    input: FanOutNotificationInput,
    options: { excludeUserId?: string } = {},
  ): Promise<number> {
    // Guard once up front — the content is identical for every recipient (fail-closed before fan-out).
    assertSafeNotificationParams(input.params ?? null);

    const holders = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        userRoles: { some: { role: { rolePermissions: { some: { permission: { code: permissionCode } } } } } },
      },
      select: { id: true },
    });
    const recipients = new Set(holders.map((u) => u.id));
    recipients.delete(options.excludeUserId ?? '');

    let notified = 0;
    for (const recipientUserId of recipients) {
      try {
        await this.emit({ ...input, recipientUserId });
        notified += 1;
      } catch (error) {
        this.logger.warn(
          `Permission-holder emit to ${recipientUserId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return notified;
  }

  /** Paged, recipient-scoped list + the recipient's TOTAL unread count (drives the FE badge). */
  async list(actor: AuthPrincipal, query: Record<string, unknown>): Promise<PaginatedNotificationListDto> {
    const { page, size, type, severity, read } = parseNotificationListQuery(query);
    // Recipient scope is ALWAYS applied — a user sees only their own notifications.
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: actor.sub,
      ...(type ? { type } : {}),
      ...(severity ? { severity } : {}),
      ...(read === undefined ? {} : read ? { readAt: { not: null } } : { readAt: null }),
    };

    // B4 (bugfix-backlog-2026-07): unread first, then BOTH groups newest-first by createdAt.
    // A single findMany cannot express ORDER BY (read_at IS NULL) DESC, created_at DESC — the old
    // `readAt asc nulls first` secondary sorted the READ group oldest-READ-first. The mixed list
    // therefore stitches the page window from the two createdAt-DESC groups inside one interactive
    // transaction (consistent snapshot; both group queries ride the
    // (recipientUserId, readAt, createdAt DESC) index).
    const skip = (page - 1) * size;
    const [totalItems, rows, unreadCount] = await this.prisma.$transaction(async (tx) => {
      const total = await tx.notification.count({ where });
      const pageRows = await (async () => {
        if (read !== undefined) {
          // A read/unread filter collapses the list to a single group — one ordered query suffices.
          return tx.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: size });
        }
        const unreadWhere = { ...where, readAt: null };
        const readWhere = { ...where, readAt: { not: null } };
        const unreadMatching = await tx.notification.count({ where: unreadWhere });
        if (skip + size <= unreadMatching) {
          // The window sits entirely inside the unread block.
          return tx.notification.findMany({ where: unreadWhere, orderBy: { createdAt: 'desc' }, skip, take: size });
        }
        if (skip >= unreadMatching) {
          // The window sits entirely inside the read block — shift the offset past the unread block.
          return tx.notification.findMany({
            where: readWhere,
            orderBy: { createdAt: 'desc' },
            skip: skip - unreadMatching,
            take: size,
          });
        }
        // The window spans the boundary: the unread tail, then the newest read rows.
        const unreadTail = await tx.notification.findMany({
          where: unreadWhere,
          orderBy: { createdAt: 'desc' },
          skip,
          take: unreadMatching - skip,
        });
        const readHead = await tx.notification.findMany({
          where: readWhere,
          orderBy: { createdAt: 'desc' },
          take: size - (unreadMatching - skip),
        });
        return [...unreadTail, ...readHead];
      })();
      const badgeUnread = await tx.notification.count({ where: { recipientUserId: actor.sub, readAt: null } });
      return [total, pageRows, badgeUnread] as const;
    });

    return {
      data: rows.map(toItemDto),
      page: {
        number: page,
        size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / size)),
      },
      unreadCount,
    };
  }

  /**
   * Mark ONE notification read — recipient-scoped. The update is filtered by BOTH id AND
   * recipientUserId, so a caller can never mark another user's notification: a non-owned (or unknown)
   * id matches 0 rows → 404. Idempotent: re-marking an already-read row is a no-op success.
   */
  async markRead(actor: AuthPrincipal, id: string): Promise<{ unreadCount: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: actor.sub, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      // Either it does not exist, is not ours (IDOR-safe), or was already read. Distinguish only
      // "exists-and-ours" from "not visible to us" — both non-visible cases collapse to 404.
      const exists = await this.prisma.notification.findFirst({
        where: { id, recipientUserId: actor.sub },
        select: { id: true },
      });
      if (!exists) {
        throw new NotFoundException({ code: 'Notification.NotFound', message: 'Notification not found.' });
      }
      // exists + ours but already read → idempotent success (fall through to count).
    }
    return { unreadCount: await this.unreadCount(actor.sub) };
  }

  /** Mark ALL of the recipient's unread notifications read. Recipient-scoped; returns 0 unread. */
  async markAll(actor: AuthPrincipal): Promise<{ unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { recipientUserId: actor.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { unreadCount: 0 };
  }

  private unreadCount(recipientUserId: string): Promise<number> {
    return this.prisma.notification.count({ where: { recipientUserId, readAt: null } });
  }

  /**
   * Retention prune (called by the scheduler). Deletes, per the policy:
   *   (a) every notification older than NOTIFICATION_RETENTION_DAYS, AND
   *   (b) for any recipient with more than the cap, the oldest rows beyond the newest cap.
   * Returns the number of rows deleted. Best-effort + idempotent — safe to run repeatedly.
   */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // (a) age-based prune.
    const byAge = await this.prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });

    // (b) per-recipient cap. Find recipients over the cap, then delete each one's overflow (oldest first).
    const overCap = await this.prisma.notification.groupBy({
      by: ['recipientUserId'],
      _count: { _all: true },
      having: { recipientUserId: { _count: { gt: NOTIFICATION_RETENTION_MAX_PER_RECIPIENT } } },
    });

    let byCap = 0;
    for (const group of overCap) {
      // Keep the newest cap rows; collect the ids beyond it (oldest) and delete them.
      const overflow = await this.prisma.notification.findMany({
        where: { recipientUserId: group.recipientUserId },
        orderBy: { createdAt: 'desc' },
        skip: NOTIFICATION_RETENTION_MAX_PER_RECIPIENT,
        select: { id: true },
      });
      if (overflow.length === 0) continue;
      const deleted = await this.prisma.notification.deleteMany({
        where: { id: { in: overflow.map((r) => r.id) } },
      });
      byCap += deleted.count;
    }

    const total = byAge.count + byCap;
    if (total > 0) this.logger.log(`Pruned ${total} notification(s) (age=${byAge.count}, cap=${byCap}).`);
    return total;
  }
}

/** Row → DTO mapper (pure; no DB). `paramsJson` is surfaced as `params`; dates as ISO strings. */
function toItemDto(row: {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  titleKey: string;
  bodyKey: string;
  paramsJson: Prisma.JsonValue | null;
  resourceType: string;
  resourceId: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationItemDto {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    titleKey: row.titleKey,
    bodyKey: row.bodyKey,
    params: (row.paramsJson ?? null) as Record<string, unknown> | null,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
