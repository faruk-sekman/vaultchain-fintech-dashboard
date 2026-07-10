/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for AnalyticsRollupScheduler (audit M5) that complement
 * analytics-rollup.scheduler.spec.ts. The base spec rejects with an Error (the `error.stack`
 * branch); this pins the non-Error rejection branch (`String(error)`) and asserts the failure is
 * logged via Logger.error, not swallowed silently — the scheduler must never crash the app.
 */
import { Logger } from '@nestjs/common';
import type { AnalyticsService } from './analytics.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AnalyticsRollupScheduler } from './analytics-rollup.scheduler';

// The rollup now acquires an advisory lock via prisma; a lock-winning mock keeps these
// error-formatting branch tests reaching rollupDailyMetrics (re-audit op-analytics-rollup-lock).
const makePrisma = () =>
  ({
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  }) as unknown as PrismaService;

describe('AnalyticsRollupScheduler — error-formatting branch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('formats a NON-Error rejection via String(error) and logs it without crashing', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // Reject with a plain string (not an Error) so the `String(error)` branch is taken.
    const rollupDailyMetrics = jest.fn().mockRejectedValue('catastrophic-non-error');
    const scheduler = new AnalyticsRollupScheduler({ rollupDailyMetrics } as unknown as AnalyticsService, makePrisma());

    await expect(scheduler.runDailyRollup()).resolves.toBeUndefined();

    expect(rollupDailyMetrics).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Daily metric rollup failed', 'catastrophic-non-error');
  });

  it('logs the success message on the happy path (the log branch, not error)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rollupDailyMetrics = jest.fn().mockResolvedValue(undefined);
    const scheduler = new AnalyticsRollupScheduler({ rollupDailyMetrics } as unknown as AnalyticsService, makePrisma());

    await scheduler.runDailyRollup();

    expect(logSpy).toHaveBeenCalledWith('Daily metric rollup complete.');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes error.stack to the logger when an Error is thrown (the Error branch)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const boom = new Error('db down');
    const rollupDailyMetrics = jest.fn().mockRejectedValue(boom);
    const scheduler = new AnalyticsRollupScheduler({ rollupDailyMetrics } as unknown as AnalyticsService, makePrisma());

    await expect(scheduler.runDailyRollup()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('Daily metric rollup failed', boom.stack);
  });
});
