/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for AnalyticsService that complement
 * analytics.service.spec.ts. Prisma's $queryRaw / $executeRaw / $transaction are fully mocked (no
 * database). These pin the branches the base spec doesn't reach: the getDailyMetrics asOf fallback
 * chain (rows asOf → metricAsOf → new Date()), the maxDate left/right null branches, metricAsOf when
 * the row is missing, the dimensioned volume-row replace (currency.trim()), and rollupDailyMetrics
 * with an explicit vs defaulted bucketDate.
 */
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

function makeService() {
  const innerTx = { $executeRaw: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(innerTx)),
    customer: { findFirst: jest.fn(), findMany: jest.fn() },
    wallet: { findFirst: jest.fn() },
  };
  return { prisma, innerTx, service: new AnalyticsService(prisma as unknown as PrismaService) };
}

const AS_OF_EARLY = new Date('2026-01-01T00:00:00.000Z');
const AS_OF_LATE = new Date('2026-02-01T00:00:00.000Z');

describe('AnalyticsService — branch coverage', () => {
  describe('getDailyMetrics asOf fallback chain', () => {
    it('derives the LATEST as_of across rows (maxDate left+right populated, both directions)', async () => {
      const { prisma, service } = makeService();
      // First row carries the later stamp, second the earlier — exercises maxDate keeping `left`.
      prisma.$queryRaw.mockResolvedValueOnce([
        { date: '2026-01-02', value: '2', as_of: AS_OF_LATE },
        { date: '2026-01-01', value: '1', as_of: AS_OF_EARLY },
      ]);
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      expect(r.asOf).toBe(AS_OF_LATE.toISOString());
    });

    it('keeps the later as_of when it arrives second (maxDate right > left)', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([
        { date: '2026-01-01', value: '1', as_of: AS_OF_EARLY },
        { date: '2026-01-02', value: '2', as_of: AS_OF_LATE },
      ]);
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      expect(r.asOf).toBe(AS_OF_LATE.toISOString());
    });

    it('falls all the way back to a fresh new Date() when rows AND metricAsOf are null', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ date: '2026-01-01', value: '5', as_of: null }]) // rows, no as_of
        .mockResolvedValueOnce([{ as_of: null }]); // metricAsOf → null
      const before = Date.now();
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      const stamped = Date.parse(r.asOf);
      expect(stamped).toBeGreaterThanOrEqual(before);
    });

    it('handles an empty result set: maxDate stays null, metricAsOf supplies the stamp', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // no rows
        .mockResolvedValueOnce([{ as_of: AS_OF_LATE }]); // metricAsOf
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      expect(r.items).toEqual([]);
      expect(r.asOf).toBe(AS_OF_LATE.toISOString());
    });

    it('maps Date-typed date columns through dateOnly', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([{ date: new Date('2026-01-05T12:00:00Z'), value: '9', as_of: AS_OF_LATE }]);
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-31' } as never);
      expect(r.items[0]).toEqual({ date: '2026-01-05', value: '9' });
    });
  });

  describe('metricAsOf row-missing branch', () => {
    it('returns a new Date() stamp when the metricAsOf query yields no row at all (row?.as_of)', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ date: '2026-01-01', value: '5', as_of: null }]) // rows w/o as_of
        .mockResolvedValueOnce([]); // metricAsOf returns no row → row is undefined → null
      const before = Date.now();
      const r = await service.getDailyMetrics({ metric: 'x', from: '2026-01-01', to: '2026-01-02' } as never);
      expect(Date.parse(r.asOf)).toBeGreaterThanOrEqual(before);
    });
  });

  describe('rollupDailyMetrics dimensioned-volume replace', () => {
    it('replaces the dimensioned currency rows (trims the currency) for an explicit bucketDate', async () => {
      const { prisma, innerTx, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { legacy_total: 4, legacy_active: 2, customers_new_daily: 1, customers_active_total_daily: 2, transactions_count_daily: 3 },
        ])
        .mockResolvedValueOnce([
          { currency: 'TRY ', value: '1000' }, // trailing space → trimmed
          { currency: 'USD', value: '500' },
        ]);
      await service.rollupDailyMetrics('2026-01-01');

      // The scalar upserts ran (5 of them) plus the replace transaction.
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // The replace deletes once and inserts once per currency row (2 rows here).
      expect(innerTx.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('still runs the replace transaction (delete only) when there are no volume rows, defaulting bucketDate', async () => {
      const { prisma, innerTx, service } = makeService();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { legacy_total: 0, legacy_active: 0, customers_new_daily: 0, customers_active_total_daily: 0, transactions_count_daily: 0 },
        ])
        .mockResolvedValueOnce([]); // no currency volume rows
      await service.rollupDailyMetrics(); // no bucketDate → COALESCE(...null...) default path

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // Just the DELETE, no per-row INSERT.
      expect(innerTx.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('backfillDailyMetrics range resolution', () => {
    it('returns 0 when only one endpoint resolves (start present, end null)', async () => {
      const { prisma, service } = makeService();
      // backfill bounds query: max_date is null → end stays null → 0.
      prisma.$queryRaw.mockResolvedValueOnce([{ min_date: '2026-01-01', max_date: null }]);
      await expect(service.backfillDailyMetrics()).resolves.toBe(0);
    });

    it('rolls up multiple days across a resolved 3-day range', async () => {
      const { prisma, service } = makeService();
      // Route $queryRaw by SQL: bounds query → range; scalar rollup → scalar shape; volume → [].
      let boundsServed = false;
      prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        if (sql.includes('source_dates') && !boundsServed) {
          boundsServed = true;
          return Promise.resolve([{ min_date: '2026-01-01', max_date: '2026-01-03' }]);
        }
        if (sql.includes('le.currency')) return Promise.resolve([]); // dimensioned volume rows
        return Promise.resolve([
          { legacy_total: 1, legacy_active: 1, customers_new_daily: 0, customers_active_total_daily: 1, transactions_count_daily: 0 },
        ]);
      });
      // Jan 1, 2, 3 → 3 rollups.
      await expect(service.backfillDailyMetrics()).resolves.toBe(3);
    });
  });

  describe('getKycDistribution non-empty asOf path', () => {
    it('uses the grouped rows own as_of (does not call summaryAsOf) when rows exist', async () => {
      const { prisma, service } = makeService();
      prisma.$queryRaw.mockResolvedValueOnce([{ status: 'PENDING', count: 2, as_of: AS_OF_LATE }]);
      const r = await service.getKycDistribution();
      expect(r.asOf).toBe(AS_OF_LATE.toISOString());
      // Only the one grouped query ran — no extra summaryAsOf round-trip.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

  describe('getLatestCustomer wallet balance nullish default', () => {
    it('serializes 0 when the wallet exists but its balance row is null (?? 0n)', async () => {
      const { prisma, service } = makeService();
      prisma.customer.findFirst.mockResolvedValue({
        id: 'c1', fullName: 'Ada Lovelace', email: 'ada@x.io', phone: '5551112233',
        kycStatus: 'VERIFIED', status: 'ACTIVE', riskLevel: 'LOW',
        createdAt: AS_OF_EARLY, updatedAt: AS_OF_EARLY,
      });
      // Wallet present but with NO balance relation loaded → balance?.balanceMinor is undefined.
      prisma.wallet.findFirst.mockResolvedValue({ currency: 'TRY', balance: null, createdAt: AS_OF_EARLY });
      const r = await service.getLatestCustomer();
      expect(r?.wallet).toEqual({ currency: 'TRY', balanceMinor: '0' });
    });
  });

  });
});
