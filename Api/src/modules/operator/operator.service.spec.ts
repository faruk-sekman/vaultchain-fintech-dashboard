/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for OperatorService (audit O-7). Prisma + Audit are mocked, so this covers the profile
 * read/update (incl. the NotFound path and the audited transaction), the `operator_settings`-backed
 * notification preferences (defaults merge + absent-row fallback), and the stored job-title
 * normalization — without a database. The settings now live in their own table, so reads hit
 * `prisma.operatorSettings` and writes upsert it *inside* the same audited transaction; the audit log
 * is no longer the source of truth (it still records THAT a change happened).
 *
 * The audit-log-shadow `listNotifications` was retired from this service (the real
 * notification domain owns the feed now), so its test moved to notification.service.spec.ts.
 */
import { NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { OperatorService } from './operator.service';

const actor = { sub: 'op-1' } as AuthPrincipal;

function makeMocks() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    operatorSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new OperatorService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { prisma, audit, service };
}

/** Build a transaction client whose tables are jest mocks, and wire $transaction to run the callback. */
function wireTx(prisma: ReturnType<typeof makeMocks>['prisma']) {
  const tx = {
    user: { update: jest.fn() },
    operatorSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  };
  prisma.$transaction.mockImplementation(async (cb: (client: unknown) => unknown) => cb(tx));
  return tx;
}

describe('OperatorService', () => {
  describe('getProfile', () => {
    it('returns the profile with the stored job title', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Ada', email: 'ada@x.io', phone: '5550000' });
      prisma.operatorSettings.findUnique.mockResolvedValue({ jobTitle: ' Analyst ' });

      await expect(service.getProfile(actor)).resolves.toEqual({
        displayName: 'Ada',
        email: 'ada@x.io',
        phone: '5550000',
        jobTitle: 'Analyst',
      });
      expect(prisma.operatorSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'op-1' } }),
      );
    });

    it('throws NotFound when the user does not exist', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getProfile(actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a null job title when no settings row exists', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Bo', email: 'bo@x.io', phone: null });
      prisma.operatorSettings.findUnique.mockResolvedValue(null);
      await expect(service.getProfile(actor)).resolves.toMatchObject({ jobTitle: null });
    });

    it('returns a null job title when the stored title is empty/whitespace', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ displayName: 'Cy', email: 'cy@x.io', phone: null });
      prisma.operatorSettings.findUnique.mockResolvedValue({ jobTitle: '   ' });
      await expect(service.getProfile(actor)).resolves.toMatchObject({ jobTitle: null });
    });
  });

  describe('updateProfile', () => {
    it('updates name/phone, upserts the job title, and audits inside the transaction', async () => {
      const { prisma, audit, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.user.update.mockResolvedValue({ displayName: 'New', email: 'e@x.io', phone: 'p' });
      tx.operatorSettings.upsert.mockResolvedValue({ userId: 'op-1', jobTitle: 'Eng' });

      const result = await service.updateProfile(actor, { displayName: 'New', phone: 'p', jobTitle: 'Eng' });

      expect(result).toEqual({ displayName: 'New', email: 'e@x.io', phone: 'p', jobTitle: 'Eng' });
      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(tx.operatorSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'op-1' },
          create: { userId: 'op-1', jobTitle: 'Eng' },
          update: { jobTitle: 'Eng' },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'operator.profile.update', outcome: 'SUCCESS', context: { jobTitle: 'Eng' } }),
        tx,
      );
    });

    it('omits undefined fields and does not touch settings when jobTitle is absent', async () => {
      const { prisma, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.user.update.mockResolvedValue({ displayName: null, email: 'e@x.io', phone: null });
      tx.operatorSettings.findUnique.mockResolvedValue(null); // no stored settings yet

      const result = await service.updateProfile(actor, {});

      expect(result.jobTitle).toBeNull();
      // No displayName/phone keys passed when undefined (omitted from the update payload).
      expect(tx.user.update.mock.calls[0][0].data).toEqual({});
      // jobTitle field absent → settings are NOT upserted (only read to echo the current value).
      expect(tx.operatorSettings.upsert).not.toHaveBeenCalled();
      expect(tx.operatorSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'op-1' } }),
      );
    });

    it('clears the job title (nulls it) when an empty string is sent', async () => {
      const { prisma, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.user.update.mockResolvedValue({ displayName: null, email: 'e@x.io', phone: null });
      tx.operatorSettings.upsert.mockResolvedValue({ userId: 'op-1', jobTitle: null });

      const result = await service.updateProfile(actor, { jobTitle: '   ' });

      expect(result.jobTitle).toBeNull();
      expect(tx.operatorSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { jobTitle: null }, create: { userId: 'op-1', jobTitle: null } }),
      );
    });
  });

  describe('notification preferences', () => {
    it('returns the stored prefs from the settings row', async () => {
      const { prisma, service } = makeMocks();
      prisma.operatorSettings.findUnique.mockResolvedValue({
        productUpdates: false,
        securityAlerts: true,
        weeklyDigest: true,
      });
      await expect(service.getNotificationPreferences(actor)).resolves.toEqual({
        productUpdates: false,
        securityAlerts: true,
        weeklyDigest: true,
      });
    });

    it('falls back to defaults when there is no settings row', async () => {
      const { prisma, service } = makeMocks();
      prisma.operatorSettings.findUnique.mockResolvedValue(null);
      await expect(service.getNotificationPreferences(actor)).resolves.toEqual({
        productUpdates: true,
        securityAlerts: true,
        weeklyDigest: false,
      });
    });

    it('applies only the defined booleans over the current row and audits the upsert', async () => {
      const { prisma, audit, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.operatorSettings.findUnique.mockResolvedValue(null); // current = defaults
      tx.operatorSettings.upsert.mockResolvedValue(undefined);

      const result = await service.updateNotificationPreferences(actor, { weeklyDigest: true });

      expect(result).toEqual({ productUpdates: true, securityAlerts: true, weeklyDigest: true });
      expect(tx.operatorSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'op-1' },
          update: { productUpdates: true, securityAlerts: true, weeklyDigest: true },
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'operator.notification_preferences.update' }),
        tx,
      );
    });

    it('merges a partial patch over the existing stored row', async () => {
      const { prisma, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.operatorSettings.findUnique.mockResolvedValue({
        productUpdates: true,
        securityAlerts: false,
        weeklyDigest: true,
      });
      tx.operatorSettings.upsert.mockResolvedValue(undefined);

      await expect(
        service.updateNotificationPreferences(actor, { productUpdates: false }),
      ).resolves.toEqual({ productUpdates: false, securityAlerts: false, weeklyDigest: true });
    });

    it('applies all three booleans on update', async () => {
      const { prisma, service } = makeMocks();
      const tx = wireTx(prisma);
      tx.operatorSettings.findUnique.mockResolvedValue(null);
      tx.operatorSettings.upsert.mockResolvedValue(undefined);

      await expect(
        service.updateNotificationPreferences(actor, { productUpdates: false, securityAlerts: false, weeklyDigest: true }),
      ).resolves.toEqual({ productUpdates: false, securityAlerts: false, weeklyDigest: true });
    });
  });
});
