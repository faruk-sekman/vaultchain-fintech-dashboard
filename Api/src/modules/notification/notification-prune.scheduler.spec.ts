/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for NotificationPruneScheduler. NotificationService + PrismaService mocked.
 * Pins the daily job behaviour AND the multi-instance single-runner gate (session-level advisory lock):
 *   - lock acquired  → prune() runs AND the lock is released (pg_advisory_unlock);
 *   - lock NOT acquired → prune() is skipped, nothing is released;
 *   - a prune failure is swallowed (logged) and the lock is STILL released in `finally`;
 *   - a lock acquire / release error never crashes the scheduler.
 */
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { NotificationService } from './notification.service';
import { NotificationPruneScheduler } from './notification-prune.scheduler';

function setup(locked = true) {
  const notifications = { prune: jest.fn().mockResolvedValue(0) };
  // $queryRaw → the advisory-lock try; $executeRaw → the unlock. Both are tagged-template fns here.
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const scheduler = new NotificationPruneScheduler(
    notifications as unknown as NotificationService,
    prisma as unknown as PrismaService,
  );
  return { notifications, prisma, scheduler };
}

describe('NotificationPruneScheduler', () => {
  it('acquires the lock, runs the prune, then releases the lock', async () => {
    const { notifications, prisma, scheduler } = setup(true);
    notifications.prune.mockResolvedValue(7);

    await scheduler.runRetentionPrune();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notifications.prune).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // unlocked in finally
  });

  it('skips the prune when another instance holds the lock (and releases nothing)', async () => {
    const { notifications, prisma, scheduler } = setup(false);

    await scheduler.runRetentionPrune();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(notifications.prune).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled(); // never acquired → never unlock
  });

  it('treats a missing/empty lock result as not-acquired and skips', async () => {
    const { notifications, prisma, scheduler } = setup(true);
    prisma.$queryRaw.mockResolvedValue([]); // no row back

    await scheduler.runRetentionPrune();

    expect(notifications.prune).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('still releases the lock when the prune throws (finally)', async () => {
    const { notifications, prisma, scheduler } = setup(true);
    notifications.prune.mockRejectedValue(new Error('db down'));

    await expect(scheduler.runRetentionPrune()).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // released despite the failure
  });

  it('also swallows a non-Error prune rejection (still releasing the lock)', async () => {
    const { notifications, prisma, scheduler } = setup(true);
    notifications.prune.mockRejectedValue('weird');

    await expect(scheduler.runRetentionPrune()).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('swallows a lock-acquire failure (never prunes, never crashes)', async () => {
    const { notifications, prisma, scheduler } = setup(true);
    prisma.$queryRaw.mockRejectedValue(new Error('lock query failed'));

    await expect(scheduler.runRetentionPrune()).resolves.toBeUndefined();
    expect(notifications.prune).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('swallows a lock-release failure in finally (Error and non-Error)', async () => {
    const { prisma, scheduler } = setup(true);
    prisma.$executeRaw.mockRejectedValueOnce(new Error('unlock failed'));
    await expect(scheduler.runRetentionPrune()).resolves.toBeUndefined();

    prisma.$executeRaw.mockRejectedValueOnce('weird-unlock');
    await expect(scheduler.runRetentionPrune()).resolves.toBeUndefined();
  });
});
