/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for AnalyticsService read models (audit 9C). Prisma $queryRaw + finders are mocked.
 * Covers the summary age-stats null branch + percent divide-by-zero guard, the KYC zero-fill across
 * the enum + the empty-distribution asOf fallback, latest-customer (null + wallet-null), and the
 * recent-customers limit clamp. (The SQL rollup/exec paths are exercised by analytics.int-spec.)
 */
import { KycStatus } from '@prisma/client';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

function makeService() {
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb({ $executeRaw: jest.fn().mockResolvedValue(undefined) })),
    customer: { findFirst: jest.fn(), findMany: jest.fn() },
    wallet: { findFirst: jest.fn() },
  };
  return { prisma, service: new AnalyticsService(prisma as unknown as PrismaService) };
}

const AS_OF = new Date('2026-01-01T00:00:00.000Z');

function maskedCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', fullName: 'Ada Lovelace', email: 'ada@x.io', phone: '5551112233',
    kycStatus: 'VERIFIED', status: 'ACTIVE', riskLevel: 'LOW',
    createdAt: AS_OF, updatedAt: AS_OF, ...overrides,
  };
}

describe('AnalyticsService', () => {
  describe('getSummary', () => {
    it('computes rates and age stats', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([
        { total_customers: 10, active_count: 6, inactive_count: 4, age_avg: 30, age_min: 20, age_max: 40, as_of: AS_OF },
      ]);
      const r = await service.getSummary();
      expect(r.totalCustomers).toBe(10);
      expect(r.activeRate).toBe(60);
      expect(r.inactiveRate).toBe(40);
      expect(r.ageStats).toEqual({ avg: 30, min: 20, max: 40 });
    });

    it('returns null age stats and 0 rates at zero customers (divide-by-zero guard)', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([
        { total_customers: 0, active_count: 0, inactive_count: 0, age_avg: null, age_min: null, age_max: null, as_of: AS_OF },
      ]);
      const r = await service.getSummary();
      expect(r.ageStats).toBeNull();
      expect(r.activeRate).toBe(0);
    });
  });

  describe('getKycDistribution', () => {
    it('zero-fills every KYC status from the grouped rows', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([{ status: 'VERIFIED', count: 3, as_of: AS_OF }]);
      const r = await service.getKycDistribution();
      expect(r.total).toBe(3);
      expect(r.items).toHaveLength(Object.values(KycStatus).length);
      expect(r.items.find(i => i.status === 'VERIFIED')).toMatchObject({ count: 3, percent: 100 });
      expect(r.items.find(i => i.status !== 'VERIFIED')).toMatchObject({ count: 0 });
    });

    it('falls back to a live asOf when there are no customers', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ as_of: AS_OF }]); // main empty, then summaryAsOf
      const r = await service.getKycDistribution();
      expect(r.total).toBe(0);
      expect(r.asOf).toBe(AS_OF.toISOString());
    });
  });

  describe('getLatestCustomer', () => {
    it('returns the masked customer + wallet balance', async () => {
      const { prisma, service } = makeService();
      prisma.customer.findFirst.mockResolvedValue(maskedCustomer());
      prisma.wallet.findFirst.mockResolvedValue({ currency: 'TRY', balance: { balanceMinor: 1500n }, createdAt: AS_OF });
      const r = await service.getLatestCustomer();
      expect(r?.customer.id).toBe('c1');
      expect(r?.wallet).toEqual({ currency: 'TRY', balanceMinor: '1500' });
    });

    it('returns null when there are no customers', async () => {
      const { prisma, service } = makeService();
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.getLatestCustomer()).resolves.toBeNull();
    });

    it('returns a null wallet when the customer has none', async () => {
      const { prisma, service } = makeService();
      prisma.customer.findFirst.mockResolvedValue(maskedCustomer());
      prisma.wallet.findFirst.mockResolvedValue(null);
      await expect(service.getLatestCustomer()).resolves.toMatchObject({ wallet: null });
    });
  });

  describe('getRecentCustomers', () => {
    it.each([
      [5, 5],
      [0, 3], // 0 is falsy → `|| 3` default, then clamp
      [100, 10],
      [Number.NaN, 3],
    ])('clamps limit %s -> take %s', async (limit, take) => {
      const { prisma, service } = makeService();
      prisma.customer.findMany.mockResolvedValue([]);
      await service.getRecentCustomers(limit);
      expect(prisma.customer.findMany.mock.calls[0][0].take).toBe(take);
    });

    it('masks each returned customer', async () => {
      const { prisma, service } = makeService();
      prisma.customer.findMany.mockResolvedValue([maskedCustomer()]);
      const r = await service.getRecentCustomers(3);
      expect(r[0].id).toBe('c1');
      expect(r[0].email).not.toBe('ada@x.io'); // masked
    });
  });

  describe('getDailyMetrics', () => {
    it('maps rows and derives asOf from the rows', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([{ date: '2026-01-01', value: '100', as_of: AS_OF }]);
      const r = await service.getDailyMetrics({ metric: 'customers.total', from: '2026-01-01', to: '2026-01-31' } as never);
      expect(r.metric).toBe('customers.total');
      expect(r.items).toEqual([{ date: '2026-01-01', value: '100' }]);
      expect(r.asOf).toBe(AS_OF.toISOString());
    });

    it('falls back to metricAsOf when the rows carry no as_of', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ date: '2026-01-01', value: '5', as_of: null }])
        .mockResolvedValueOnce([{ as_of: AS_OF }]);
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      expect(r.asOf).toBe(AS_OF.toISOString());
    });
  });

  describe('rollup + maintenance', () => {
    it('rollupDailyMetrics writes the scalar upserts + the dimensioned replace', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ legacy_total: 10, legacy_active: 6, customers_new_daily: 2, customers_active_total_daily: 6, transactions_count_daily: 3 }])
        .mockResolvedValueOnce([{ currency: 'TRY', value: '1000' }]);
      await service.rollupDailyMetrics('2026-01-01');
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('backfillDailyMetrics returns 0 for an empty source range', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([{ min_date: null, max_date: null }]);
      await expect(service.backfillDailyMetrics()).resolves.toBe(0);
    });

    it('backfillDailyMetrics rolls up each day in the resolved range', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValue([{
        min_date: '2026-01-01', max_date: '2026-01-01',
        legacy_total: 1, legacy_active: 1, customers_new_daily: 0, customers_active_total_daily: 1, transactions_count_daily: 0,
        currency: 'TRY', value: '0',
      }]);
      await expect(service.backfillDailyMetrics('2026-01-01', '2026-01-01')).resolves.toBe(1);
    });

    it('refreshMaterializedViews runs the two CONCURRENTLY refreshes', async () => {
      const { prisma, service } = makeService();
      await service.refreshMaterializedViews();
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    });
  });
});
