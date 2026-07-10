/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for AnalyticsRollupScheduler (audit M5): the idempotent daily rollup, the single-runner
 * advisory-lock gate (re-audit op-analytics-rollup-lock), and the fail-safe error handling.
 */
import { Logger } from '@nestjs/common';
import type { AnalyticsService } from './analytics.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AnalyticsRollupScheduler } from './analytics-rollup.scheduler';

const makePrisma = (locked = true) =>
  ({
    $queryRaw: jest.fn().mockResolvedValue([{ locked }]),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  }) as unknown as PrismaService;

const makeScheduler = (rollupDailyMetrics: jest.Mock, prisma: PrismaService = makePrisma()) =>
  new AnalyticsRollupScheduler({ rollupDailyMetrics } as unknown as AnalyticsService, prisma);

describe('AnalyticsRollupScheduler', () => {
  it('runs the idempotent daily rollup when it wins the advisory lock', async () => {
    const rollupDailyMetrics = jest.fn().mockResolvedValue(undefined);
    const scheduler = makeScheduler(rollupDailyMetrics);

    await scheduler.runDailyRollup();

    expect(rollupDailyMetrics).toHaveBeenCalledTimes(1);
  });

  it('skips the rollup when another instance holds the lock (op-analytics-rollup-lock)', async () => {
    const rollupDailyMetrics = jest.fn().mockResolvedValue(undefined);
    const scheduler = makeScheduler(rollupDailyMetrics, makePrisma(false));

    await scheduler.runDailyRollup();

    expect(rollupDailyMetrics).not.toHaveBeenCalled();
  });

  it('swallows a rollup failure so the scheduler never crashes the app', async () => {
    const rollupDailyMetrics = jest.fn().mockRejectedValue(new Error('db down'));
    const scheduler = makeScheduler(rollupDailyMetrics);

    await expect(scheduler.runDailyRollup()).resolves.toBeUndefined();
    expect(rollupDailyMetrics).toHaveBeenCalledTimes(1);
  });

  it('logs but does not throw when releasing the advisory lock fails', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rollupDailyMetrics = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      $executeRaw: jest.fn().mockRejectedValue(new Error('unlock failed')),
    } as unknown as PrismaService;

    await expect(makeScheduler(rollupDailyMetrics, prisma).runDailyRollup()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Daily metric rollup lock release failed', expect.anything());
  });

  it('skips defensively when the lock query returns no row', async () => {
    const rollupDailyMetrics = jest.fn();
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
    } as unknown as PrismaService;

    await makeScheduler(rollupDailyMetrics, prisma).runDailyRollup();

    expect(rollupDailyMetrics).not.toHaveBeenCalled();
  });

  it('formats a non-Error unlock rejection via String() without throwing', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rollupDailyMetrics = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      $executeRaw: jest.fn().mockRejectedValue('raw-unlock-failure'),
    } as unknown as PrismaService;

    await expect(makeScheduler(rollupDailyMetrics, prisma).runDailyRollup()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('Daily metric rollup lock release failed', 'raw-unlock-failure');
  });
});
