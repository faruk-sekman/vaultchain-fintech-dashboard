/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CustomerTransactionsService } from './customer-transactions.service';

describe('CustomerTransactionsService', () => {
  it('lists transactions across all non-system customer wallets', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'tx-usd',
        publicRef: 'TX-USD',
        kind: 'DEPOSIT',
        status: 'POSTED',
        description: 'USD salary',
        occurredAt: new Date('2026-03-01T10:00:00Z'),
        postedAt: new Date('2026-03-01T10:00:00Z'),
        entries: [{ leg: 'CREDIT', amountMinor: 12500n, currency: 'USD' }],
      },
    ]);
    const count = jest.fn().mockResolvedValue(1);
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findMany: jest.fn().mockResolvedValue([{ id: 'wallet-try' }, { id: 'wallet-usd' }]) },
      transaction: { findMany, count },
      $transaction: jest.fn((promises: Array<Promise<unknown>>) => Promise.all(promises)),
    };

    const service = new CustomerTransactionsService(prisma as never);
    const result = await service.listForCustomer('customer-1', {
      'filter[occurredFrom]': '2026-01-01T00:00:00Z',
      'filter[occurredTo]': '2026-06-01T00:00:00Z',
      'filter[currency]': 'USD',
    });

    expect(prisma.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isSystem: false, account: { customerId: 'customer-1' } } }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entries: { some: { walletId: { in: ['wallet-try', 'wallet-usd'] }, currency: 'USD' } },
        }),
        include: {
          entries: {
            where: { walletId: { in: ['wallet-try', 'wallet-usd'] }, currency: 'USD' },
            orderBy: { entrySeq: 'asc' },
          },
        },
      }),
    );
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entries: { some: { walletId: { in: ['wallet-try', 'wallet-usd'] }, currency: 'USD' } },
        }),
      }),
    );
    expect(result.data).toEqual([
      expect.objectContaining({ id: 'tx-usd', amountMinor: '12500', currency: 'USD' }),
    ]);
  });

  it('nets ALL of a customer own legs on a multi-wallet transaction, not just the first (BE-004)', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'tx-multi',
        publicRef: 'TX-M',
        kind: 'TRANSFER',
        status: 'POSTED',
        description: null,
        occurredAt: new Date('2026-03-01T10:00:00Z'),
        postedAt: new Date('2026-03-01T10:00:00Z'),
        // Two customer-owned legs (e.g. an intra-customer move) — the old entries[0]-only code dropped
        // the second and would have returned -5000; the fix nets -5000 (DEBIT) + 12500 (CREDIT) = 7500.
        entries: [
          { leg: 'DEBIT', amountMinor: 5000n, currency: 'USD' },
          { leg: 'CREDIT', amountMinor: 12500n, currency: 'USD' },
        ],
      },
    ]);
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'customer-1' }) },
      wallet: { findMany: jest.fn().mockResolvedValue([{ id: 'wallet-a' }, { id: 'wallet-b' }]) },
      transaction: { findMany, count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((promises: Array<Promise<unknown>>) => Promise.all(promises)),
    };

    const service = new CustomerTransactionsService(prisma as never);
    const result = await service.listForCustomer('customer-1', {
      'filter[occurredFrom]': '2026-01-01T00:00:00Z',
      'filter[occurredTo]': '2026-06-01T00:00:00Z',
    });

    expect(result.data[0]).toEqual(expect.objectContaining({ amountMinor: '7500', currency: 'USD' }));
  });
});
