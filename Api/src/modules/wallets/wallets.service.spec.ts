/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the customer wallet read + limit-write service. Prisma and the
 * audit service are mocked: these pin the bigint→Number DTO mapping, the dailyLimit<monthlyLimit
 * rule, the optimistic-concurrency guard (rowVersion mismatch → 409), and that a successful limit
 * change is audited. The real DB path is covered by wallets.int-spec.ts.
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { UpdateWalletLimitsDto } from './dto/update-wallet-limits.dto';
import { WalletsService } from './wallets.service';

const actor = { sub: 'user-1' } as unknown as AuthPrincipal;

/** A full wallet row as `getForCustomer` reads it, with bigint money/limit columns. */
const walletRow = (over: Record<string, unknown> = {}) => ({
  id: 'wallet-1',
  currency: 'USD',
  balance: { balanceMinor: 12_500n, availableBalanceMinor: 10_000n },
  dailyLimitMinor: 100_000n,
  monthlyLimitMinor: 500_000n,
  status: 'ACTIVE',
  rowVersion: 3n,
  ...over,
});

const makeAudit = () => ({ record: jest.fn().mockResolvedValue(undefined) });

describe('WalletsService.getForCustomer', () => {
  it('maps the wallet row to a DTO with all bigint columns narrowed to Number', async () => {
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue(walletRow()) },
    };
    const service = new WalletsService(prisma as never, makeAudit() as never);

    const result = await service.getForCustomer('customer-1');

    expect(result).toEqual({
      id: 'wallet-1',
      currency: 'USD',
      balanceMinor: '12500',
      availableBalanceMinor: '10000',
      dailyLimitMinor: '100000',
      monthlyLimitMinor: '500000',
      status: 'ACTIVE',
      rowVersion: 3,
    });
    // Soft-delete awareness: the customer lookup excludes deleted rows.
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'customer-1', deletedAt: null } }));
  });

  it('throws 404 when the customer is absent (or soft-deleted)', async () => {
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue(null) },
      wallet: { findFirst: jest.fn() },
    };
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await expect(service.getForCustomer('missing')).rejects.toMatchObject({ response: { code: 'Customers.NotFound' } });
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('throws 404 when the customer has no wallet', async () => {
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await expect(service.getForCustomer('customer-1')).rejects.toMatchObject({ response: { code: 'Wallets.NotFound' } });
  });

  it('defaults missing balance rows to zero', async () => {
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue(walletRow({ balance: null })) },
    };
    const service = new WalletsService(prisma as never, makeAudit() as never);

    const result = await service.getForCustomer('customer-1');

    expect(result).toMatchObject({ balanceMinor: '0', availableBalanceMinor: '0' });
  });
});

describe('WalletsService.updateLimits', () => {
  const dto = (over: Partial<UpdateWalletLimitsDto> = {}): UpdateWalletLimitsDto =>
    ({ dailyLimit: 1_000, monthlyLimit: 5_000, rowVersion: 3, ...over }) as UpdateWalletLimitsDto;

  /** Builds a prisma mock whose `$transaction` runs the callback against a tx-scoped client. */
  function makePrisma(tx: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue(walletRow()) },
      $transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
      ...over,
    };
  }

  it('rejects dailyLimit >= monthlyLimit with 400 before touching the database', async () => {
    const tx = {};
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await expect(service.updateLimits('customer-1', dto({ dailyLimit: 5_000, monthlyLimit: 5_000 }), actor)).rejects.toMatchObject({
      response: { code: 'Wallets.InvalidLimits' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('converts MAJOR units to minor, writes guarded on rowVersion, and audits the change', async () => {
    const tx = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'wallet-1', currency: 'USD' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      currency: { findUnique: jest.fn().mockResolvedValue({ scale: 2 }) },
    };
    const audit = makeAudit();
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, audit as never);

    const result = await service.updateLimits('customer-1', dto(), actor);

    // 1_000 / 5_000 major → 100_000 / 500_000 minor, optimistic guard on rowVersion 3.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'wallet-1', rowVersion: 3n },
      data: { dailyLimitMinor: 100_000n, monthlyLimitMinor: 500_000n, rowVersion: { increment: 1 } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wallet.update_limits', resourceId: 'wallet-1', outcome: 'SUCCESS' }),
      tx,
    );
    // Returns the refreshed detail (read back via getForCustomer).
    expect(result).toMatchObject({ id: 'wallet-1', dailyLimitMinor: '100000', monthlyLimitMinor: '500000' });
  });

  it('defaults to scale 2 when the wallet currency is not in the catalog (BE-001 fallback)', async () => {
    const tx = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'wallet-1', currency: 'ZZZ' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      currency: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await service.updateLimits('customer-1', dto({ dailyLimit: 1_000, monthlyLimit: 5_000 }), actor);

    // Unknown currency → scale falls back to 2 (×100): 1000 major → 100000 minor.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dailyLimitMinor: 100_000n }) }),
    );
  });

  it('honours a non-scale-2 currency scale (BE-001: no hardcoded ×100)', async () => {
    const tx = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'wallet-1', currency: 'JPY' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      currency: { findUnique: jest.fn().mockResolvedValue({ scale: 0 }) },
    };
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await service.updateLimits('customer-1', dto({ dailyLimit: 5_000, monthlyLimit: 50_000 }), actor);

    // scale 0 → ×1 (NOT the old hardcoded ×100): 5000 major → 5000 minor, 50000 → 50000.
    expect(tx.wallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dailyLimitMinor: 5_000n, monthlyLimitMinor: 50_000n }) }),
    );
    expect(tx.currency.findUnique).toHaveBeenCalledWith({ where: { code: 'JPY' }, select: { scale: true } });
  });

  it('throws 409 when the rowVersion no longer matches (optimistic-concurrency loss)', async () => {
    const tx = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue({ id: 'wallet-1', currency: 'USD' }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      currency: { findUnique: jest.fn().mockResolvedValue({ scale: 2 }) },
    };
    const audit = makeAudit();
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, audit as never);

    await expect(service.updateLimits('customer-1', dto(), actor)).rejects.toMatchObject({ response: { code: 'Wallets.Conflict' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('throws 404 when the wallet is gone inside the transaction', async () => {
    const tx = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
    };
    const prisma = makePrisma(tx);
    const service = new WalletsService(prisma as never, makeAudit() as never);

    await expect(service.updateLimits('customer-1', dto(), actor)).rejects.toMatchObject({ response: { code: 'Wallets.NotFound' } });
  });
});
