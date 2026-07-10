/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for NotificationService. Mocked Prisma + RealtimeService. Covers:
 *   - emit(): writes a recipient-scoped row, publishes a RECIPIENT-SCOPED `notification.created` SSE
 *     event, is SEPARATE from audit (no AuditService dependency at all), the params guard fail-closed,
 *     and the dedupe (idempotent) path.
 *   - list(): recipient scope is ALWAYS applied; the unreadCount + page math; filter mapping.
 *   - markRead()/markAll(): recipient-scoped; 404 on a non-owned id; idempotent already-read.
 *   - prune(): age + per-recipient-cap retention.
 *   - emitToOperatorsWithPreference(): preference fan-out, actor exclusion, default-on inclusion.
 *   - emitToPermissionHolders() (A15): permission-filtered ACTIVE recipients, actor exclusion,
 *     best-effort per recipient, params guard fail-closed, NO default-on backfill.
 */
import { NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { NotificationService, NOTIFICATION_RETENTION_MAX_PER_RECIPIENT } from './notification.service';

const actor = { sub: 'user-A', permissions: [], permissionVersion: 0 } as AuthPrincipal;

function makeMocks() {
  const prisma = {
    notification: {
      create: jest.fn().mockResolvedValue(undefined),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    operatorSettings: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // list() uses the INTERACTIVE form (window-stitched B4 ordering) — hand it this same mock as
    // the tx client; other call sites still use the ARRAY form. Wired below (self-reference).
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
  );
  const realtime = { emit: jest.fn() };
  const service = new NotificationService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
  );
  return { prisma, realtime, service };
}

const baseEmit = {
  recipientUserId: 'user-A',
  type: 'SECURITY_ALERT' as const,
  severity: 'critical' as const,
  titleKey: 'notifications.security.adminPasswordReset.title',
  bodyKey: 'notifications.security.adminPasswordReset.body',
  resourceType: 'user',
  resourceId: '0190a0b0-0000-7000-8000-000000000001',
};

describe('NotificationService', () => {
  describe('emit', () => {
    it('writes a recipient-scoped row and publishes a RECIPIENT-SCOPED SSE event', async () => {
      const { prisma, realtime, service } = makeMocks();
      const res = await service.emit(baseEmit);

      expect(res.deduped).toBe(false);
      const created = prisma.notification.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ recipientUserId: 'user-A', type: 'SECURITY_ALERT', severity: 'critical' });
      // The SSE event MUST carry the recipient scope so only user-A's stream receives it.
      expect(realtime.emit).toHaveBeenCalledWith('notification.created', created.id, { recipientUserId: 'user-A' });
    });

    it('is SEPARATE from audit — the service has no AuditService and writes only a notification row', async () => {
      const { prisma, service } = makeMocks();
      await service.emit(baseEmit);
      // Only the notification table is written. (The service constructor takes no AuditService — proven
      // by makeMocks not providing one — so emit can never duplicate the audit trail.)
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('fail-closed: rejects PII params BEFORE writing or emitting', async () => {
      const { prisma, realtime, service } = makeMocks();
      await expect(service.emit({ ...baseEmit, params: { email: 'a@b.com' } })).rejects.toThrow();
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('dedupes a recent duplicate (idempotent) — no second row, no second SSE', async () => {
      const { prisma, realtime, service } = makeMocks();
      prisma.notification.findFirst.mockResolvedValue({ id: 'existing-id' });
      const res = await service.emit({ ...baseEmit, dedupeKey: 'k1' });
      expect(res).toEqual({ id: 'existing-id', deduped: true });
      expect(prisma.notification.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('creates a fresh row when dedupeKey finds no recent match', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.findFirst.mockResolvedValue(null);
      const res = await service.emit({ ...baseEmit, dedupeKey: 'k1' });
      expect(res.deduped).toBe(false);
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    });

    it('dedupe match query coalesces an absent resourceId to null', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.findFirst.mockResolvedValue(null);
      // No resourceId on the input → the dedupe WHERE must search on `resourceId: null` (the `?? null`
      // arm), not `undefined` (which Prisma would treat as "any").
      const { resourceId: _omit, ...noResource } = baseEmit;
      await service.emit({ ...noResource, dedupeKey: 'k1' });
      expect(prisma.notification.findFirst.mock.calls[0][0].where).toMatchObject({ resourceId: null });
    });
  });

  describe('list', () => {
    it('ALWAYS scopes to the recipient and returns unreadCount + page meta', async () => {
      const { prisma, service } = makeMocks();
      // Mixed-list counts: total, unread-in-window, then the badge unread (always last).
      prisma.notification.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
      prisma.notification.findMany
        .mockResolvedValueOnce([
          {
            id: 'n1',
            type: 'SECURITY_ALERT',
            severity: 'critical',
            titleKey: 't',
            bodyKey: 'b',
            paramsJson: { count: 2 },
            resourceType: 'user',
            resourceId: 'r1',
            readAt: null,
            createdAt: new Date('2026-06-29T00:00:00.000Z'),
          },
        ])
        .mockResolvedValue([]);

      const res = await service.list(actor, {});

      // Recipient scope present on BOTH the page query and the unread count.
      expect(prisma.notification.findMany.mock.calls[0][0].where).toMatchObject({ recipientUserId: 'user-A' });
      expect(prisma.notification.count).toHaveBeenLastCalledWith({ where: { recipientUserId: 'user-A', readAt: null } });
      expect(res.unreadCount).toBe(1);
      expect(res.page).toMatchObject({ number: 1, totalItems: 1, totalPages: 1 });
      expect(res.data[0]).toMatchObject({ id: 'n1', params: { count: 2 }, readAt: null, createdAt: '2026-06-29T00:00:00.000Z' });
    });

    it('B4: every group query orders by createdAt DESC — never by readAt', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.count.mockResolvedValue(0);
      prisma.notification.findMany.mockResolvedValue([]);
      await service.list(actor, {});
      for (const call of prisma.notification.findMany.mock.calls) {
        expect(call[0].orderBy).toEqual({ createdAt: 'desc' });
      }
    });

    it('B4 window: a page fully inside the unread block queries ONLY the unread group', async () => {
      const { prisma, service } = makeMocks();
      // total=40, unread-in-window=30 (page 1 × size 15 fits inside), badge=30.
      prisma.notification.count.mockResolvedValueOnce(40).mockResolvedValueOnce(30).mockResolvedValueOnce(30);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.list(actor, { 'page[number]': '1', 'page[size]': '15' });

      expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({
        where: { recipientUserId: 'user-A', readAt: null },
        skip: 0,
        take: 15,
      });
    });

    it('B4 window: a page past the unread block queries ONLY the read group with a shifted offset', async () => {
      const { prisma, service } = makeMocks();
      // total=40, unread=10 → page 2 (skip 15) starts 5 rows into the read block.
      prisma.notification.count.mockResolvedValueOnce(40).mockResolvedValueOnce(10).mockResolvedValueOnce(10);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.list(actor, { 'page[number]': '2', 'page[size]': '15' });

      expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({
        where: { recipientUserId: 'user-A', readAt: { not: null } },
        skip: 5,
        take: 15,
      });
    });

    it('B4 window: a page spanning the boundary stitches the unread tail before the newest read rows', async () => {
      const { prisma, service } = makeMocks();
      // total=20, unread=5 → page 1 (size 15) = 5 unread + the 10 newest read.
      prisma.notification.count.mockResolvedValueOnce(20).mockResolvedValueOnce(5).mockResolvedValueOnce(5);
      const row = (id: string, readAt: Date | null) => ({
        id,
        type: 'SYSTEM',
        severity: 'info',
        titleKey: 't',
        bodyKey: 'b',
        paramsJson: null,
        resourceType: 'system',
        resourceId: null,
        readAt,
        createdAt: new Date('2026-06-29T00:00:00.000Z'),
      });
      prisma.notification.findMany
        .mockResolvedValueOnce([row('u1', null), row('u2', null)])
        .mockResolvedValueOnce([row('r1', new Date()), row('r2', new Date())]);

      const res = await service.list(actor, { 'page[number]': '1', 'page[size]': '15' });

      // Unread slice first (take = 5-0), then the read head (take = 15-5) — stitched in order.
      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({
        where: { recipientUserId: 'user-A', readAt: null },
        skip: 0,
        take: 5,
      });
      expect(prisma.notification.findMany.mock.calls[1][0]).toMatchObject({
        where: { recipientUserId: 'user-A', readAt: { not: null } },
        take: 10,
      });
      expect(res.data.map((n) => n.id)).toEqual(['u1', 'u2', 'r1', 'r2']);
    });

    it('maps the read filter to readAt null / not-null', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.count.mockResolvedValue(0);
      prisma.notification.findMany.mockResolvedValue([]);

      await service.list(actor, { 'filter[read]': 'false' });
      expect(prisma.notification.findMany.mock.calls[0][0].where).toMatchObject({ readAt: null });

      await service.list(actor, { 'filter[read]': 'true' });
      expect(prisma.notification.findMany.mock.calls[1][0].where).toMatchObject({ readAt: { not: null } });
    });

    it('threads the type + severity filters into the recipient-scoped WHERE clause', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.count.mockResolvedValue(0);
      prisma.notification.findMany.mockResolvedValue([]);
      await service.list(actor, { 'filter[type]': 'SECURITY_ALERT', 'filter[severity]': 'critical' });
      // Both filters (the truthy spread arms) must reach the WHERE — still under the recipient scope.
      expect(prisma.notification.findMany.mock.calls[0][0].where).toMatchObject({
        recipientUserId: 'user-A',
        type: 'SECURITY_ALERT',
        severity: 'critical',
      });
    });

    it('maps a null paramsJson to params: null', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.count.mockResolvedValue(0);
      prisma.notification.findMany.mockResolvedValue([
        { id: 'n2', type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', paramsJson: null, resourceType: 'system', resourceId: null, readAt: new Date('2026-06-29T00:00:00.000Z'), createdAt: new Date('2026-06-29T00:00:00.000Z') },
      ]);
      const res = await service.list(actor, {});
      expect(res.data[0].params).toBeNull();
      expect(res.data[0].readAt).toBe('2026-06-29T00:00:00.000Z');
    });
  });

  describe('markRead', () => {
    it('marks an owned unread notification read and returns the new unread count', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.count.mockResolvedValue(2);
      const res = await service.markRead(actor, 'n1');
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', recipientUserId: 'user-A', readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(res.unreadCount).toBe(2);
    });

    it('404s when the id is not owned/known (IDOR-safe — never 200 for another user\'s row)', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });
      prisma.notification.findFirst.mockResolvedValue(null); // not visible to this recipient
      await expect(service.markRead(actor, 'someone-elses')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent: an already-read owned row returns success (no 404)', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.updateMany.mockResolvedValue({ count: 0 }); // nothing to flip (already read)
      prisma.notification.findFirst.mockResolvedValue({ id: 'n1' }); // exists + ours
      prisma.notification.count.mockResolvedValue(0);
      await expect(service.markRead(actor, 'n1')).resolves.toEqual({ unreadCount: 0 });
    });
  });

  describe('markAll', () => {
    it('marks all the recipient\'s unread read and returns 0', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.updateMany.mockResolvedValue({ count: 5 });
      const res = await service.markAll(actor);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { recipientUserId: 'user-A', readAt: null },
        data: { readAt: expect.any(Date) },
      });
      expect(res.unreadCount).toBe(0);
    });
  });

  describe('prune', () => {
    it('prunes by age and reports the count', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.deleteMany.mockResolvedValueOnce({ count: 4 }); // age prune
      prisma.notification.groupBy.mockResolvedValue([]); // no one over cap
      const total = await service.prune();
      expect(total).toBe(4);
      expect(prisma.notification.deleteMany.mock.calls[0][0]).toMatchObject({ where: { createdAt: { lt: expect.any(Date) } } });
    });

    it('prunes a recipient over the cap (oldest overflow)', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.deleteMany
        .mockResolvedValueOnce({ count: 0 }) // age prune
        .mockResolvedValueOnce({ count: 3 }); // cap overflow delete
      prisma.notification.groupBy.mockResolvedValue([{ recipientUserId: 'user-A', _count: { _all: NOTIFICATION_RETENTION_MAX_PER_RECIPIENT + 3 } }]);
      prisma.notification.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }]);
      const total = await service.prune();
      expect(total).toBe(3);
      // overflow query skips the cap (keeps the newest), deletes the rest.
      expect(prisma.notification.findMany.mock.calls[0][0]).toMatchObject({ skip: NOTIFICATION_RETENTION_MAX_PER_RECIPIENT });
    });

    it('skips the cap delete when the overflow window is empty (benign race → no deleteMany)', async () => {
      const { prisma, service } = makeMocks();
      prisma.notification.deleteMany.mockResolvedValueOnce({ count: 0 }); // age prune only
      // groupBy flags a recipient as over-cap, but by the time we page the overflow it is empty (rows
      // already pruned by a concurrent run) → the `overflow.length === 0` continue arm; no cap delete.
      prisma.notification.groupBy.mockResolvedValue([{ recipientUserId: 'user-A', _count: { _all: NOTIFICATION_RETENTION_MAX_PER_RECIPIENT + 1 } }]);
      prisma.notification.findMany.mockResolvedValue([]);
      const total = await service.prune();
      expect(total).toBe(0);
      // Only the age-prune deleteMany ran; the cap-overflow deleteMany was skipped by `continue`.
      expect(prisma.notification.deleteMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitToOperatorsWithPreference', () => {
    it('fans out to opted-in operators + default-on users without a settings row, excluding the actor', async () => {
      const { prisma, realtime, service } = makeMocks();
      prisma.operatorSettings.findMany.mockResolvedValue([{ userId: 'op-1' }, { userId: 'op-2' }]);
      prisma.user.findMany.mockResolvedValue([{ id: 'op-3' }]); // no settings row → default-on
      prisma.notification.create.mockResolvedValue(undefined);

      const notified = await service.emitToOperatorsWithPreference(
        'productUpdates',
        { type: 'KYC_EVENT', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'customer', resourceId: 'c1', params: { customerId: 'c1' } },
        { excludeUserId: 'op-2' },
      );

      // op-1 + op-3 notified; op-2 excluded.
      expect(notified).toBe(2);
      const recipients = realtime.emit.mock.calls.map((c) => c[2].recipientUserId).sort();
      expect(recipients).toEqual(['op-1', 'op-3']);
    });

    it('weeklyDigest does NOT include users without a settings row (off-by-default)', async () => {
      const { prisma, service } = makeMocks();
      prisma.operatorSettings.findMany.mockResolvedValue([{ userId: 'op-1' }]);
      const userFindMany = prisma.user.findMany;
      const notified = await service.emitToOperatorsWithPreference('weeklyDigest', {
        type: 'SYSTEM',
        severity: 'info',
        titleKey: 't',
        bodyKey: 'b',
        resourceType: 'system',
      });
      expect(notified).toBe(1);
      expect(userFindMany).not.toHaveBeenCalled(); // no default-on backfill for weeklyDigest
    });

    it('is best-effort per recipient: failed emits are logged (both Error + non-Error) and never abort the rest', async () => {
      const { prisma, service } = makeMocks();
      prisma.operatorSettings.findMany.mockResolvedValue([{ userId: 'op-1' }, { userId: 'op-2' }, { userId: 'op-3' }]);
      // Two recipients fail — one with an Error (→ `error.message`), one with a NON-Error string (→
      // `'unknown error'`), covering BOTH arms of the catch's message; the third still succeeds.
      prisma.notification.create
        .mockRejectedValueOnce(new Error('db exploded')) // Error arm
        .mockRejectedValueOnce('string reject') //          non-Error arm
        .mockResolvedValue(undefined); //                   success
      const warn = jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);

      const notified = await service.emitToOperatorsWithPreference('weeklyDigest', {
        type: 'SYSTEM',
        severity: 'info',
        titleKey: 't',
        bodyKey: 'b',
        resourceType: 'system',
      });

      // Exactly one of the three succeeded; the other two were swallowed + warned (loop never aborts).
      expect(notified).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(messages).toContain('db exploded'); //   Error arm surfaced the real message
      expect(messages).toContain('unknown error'); // non-Error arm fell back to the generic message
      warn.mockRestore();
    });

    it('fail-closed: a forbidden param aborts the whole fan-out before any write', async () => {
      const { prisma, service } = makeMocks();
      await expect(
        service.emitToOperatorsWithPreference('productUpdates', {
          type: 'KYC_EVENT',
          severity: 'info',
          titleKey: 't',
          bodyKey: 'b',
          resourceType: 'customer',
          params: { email: 'a@b.com' },
        }),
      ).rejects.toThrow();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('emitToPermissionHolders (A15)', () => {
    const requestEvent = {
      type: 'SECURITY_ALERT' as const,
      severity: 'warning' as const,
      titleKey: 'notifications.security.resetRequestCreated.title',
      bodyKey: 'notifications.security.resetRequestCreated.body',
      params: { account: 'a***@e***.com' }, // masked — the guard must accept it
      resourceType: 'password_reset_request',
      resourceId: '0190a0b0-0000-7000-8000-000000000002',
    };

    it('queries ACTIVE users holding the permission through their roles and notifies each', async () => {
      const { prisma, realtime, service } = makeMocks();
      prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      const notified = await service.emitToPermissionHolders('auth.password.admin_reset', requestEvent);

      expect(notified).toBe(2);
      // Recipient resolution filters by status ACTIVE + the role→permission join on the given code.
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: {
          status: 'ACTIVE',
          userRoles: {
            some: { role: { rolePermissions: { some: { permission: { code: 'auth.password.admin_reset' } } } } },
          },
        },
        select: { id: true },
      });
      const recipients = realtime.emit.mock.calls.map((c) => c[2].recipientUserId).sort();
      expect(recipients).toEqual(['admin-1', 'admin-2']);
    });

    it('excludes the actor via excludeUserId', async () => {
      const { prisma, realtime, service } = makeMocks();
      prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      const notified = await service.emitToPermissionHolders('auth.password.admin_reset', requestEvent, {
        excludeUserId: 'admin-1',
      });

      expect(notified).toBe(1);
      expect(realtime.emit.mock.calls.map((c) => c[2].recipientUserId)).toEqual(['admin-2']);
    });

    it('has NO default-on backfill: zero holders → zero notified (permission grants are explicit)', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findMany.mockResolvedValue([]);
      const notified = await service.emitToPermissionHolders('auth.password.admin_reset', requestEvent);
      expect(notified).toBe(0);
      expect(prisma.notification.create).not.toHaveBeenCalled();
      // The preference table is never consulted on the permission path.
      expect(prisma.operatorSettings.findMany).not.toHaveBeenCalled();
    });

    it('is best-effort per recipient: a failed emit (Error and non-Error) is warned, the rest proceed', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }, { id: 'admin-3' }]);
      prisma.notification.create
        .mockRejectedValueOnce(new Error('db exploded')) // Error arm
        .mockRejectedValueOnce('string reject') //          non-Error arm
        .mockResolvedValue(undefined); //                   success
      const warn = jest
        .spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);

      const notified = await service.emitToPermissionHolders('auth.password.admin_reset', requestEvent);

      expect(notified).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((c) => c[0]).join('\n');
      expect(messages).toContain('db exploded');
      expect(messages).toContain('unknown error');
      warn.mockRestore();
    });

    it('fail-closed: a forbidden param (raw email) aborts the whole fan-out before recipient lookup', async () => {
      const { prisma, service } = makeMocks();
      await expect(
        service.emitToPermissionHolders('auth.password.admin_reset', {
          ...requestEvent,
          params: { account: 'raw-address@example.com' }, // UNmasked → the value scan must reject
        }),
      ).rejects.toThrow();
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });
  });
});
