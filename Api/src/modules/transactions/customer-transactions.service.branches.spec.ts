/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for CustomerTransactionsService that complement
 * customer-transactions.service.spec.ts. Prisma is fully mocked (no database). These pin the
 * read-path branches the happy-path spec doesn't reach: the 404-when-customer-absent guard, the
 * empty-page short-circuit when the customer owns no wallet, the optional kind/status/currency
 * filter spreads, the SIGNED-net DEBIT vs CREDIT vs no-entry serialization, and the pagination
 * `totalPages` math (including the empty-result floor of 1).
 */
import { NotFoundException } from '@nestjs/common';
import { CustomerTransactionsService } from './customer-transactions.service';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-06-01T00:00:00.000Z';
const RANGE = { 'filter[occurredFrom]': FROM, 'filter[occurredTo]': TO };

/** A prisma double whose transaction.findMany/count are configurable per test. */
function makePrisma(over: {
  customer?: unknown;
  wallets?: Array<{ id: string }>;
  rows?: unknown[];
  count?: number;
} = {}) {
  const findMany = jest.fn().mockResolvedValue(over.rows ?? []);
  const count = jest.fn().mockResolvedValue(over.count ?? (over.rows?.length ?? 0));
  const prisma = {
    customer: { findFirst: jest.fn().mockResolvedValue(over.customer === undefined ? { id: 'customer-1' } : over.customer) },
    wallet: { findMany: jest.fn().mockResolvedValue(over.wallets ?? [{ id: 'wallet-1' }]) },
    transaction: { findMany, count },
    $transaction: jest.fn((promises: Array<Promise<unknown>>) => Promise.all(promises)),
  };
  return { prisma, findMany, count };
}

function txRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    publicRef: 'TX-1',
    kind: 'TRANSFER',
    status: 'POSTED',
    description: 'desc',
    occurredAt: new Date('2026-03-01T10:00:00Z'),
    postedAt: new Date('2026-03-01T10:00:00Z'),
    entries: [{ leg: 'CREDIT', amountMinor: 12_500n, currency: 'USD' }],
    ...over,
  };
}

describe('CustomerTransactionsService — read-path branches', () => {
  it('throws 404 when the customer is absent', async () => {
    const { prisma } = makePrisma({ customer: null });
    const service = new CustomerTransactionsService(prisma as never);

    await expect(service.listForCustomer('ghost', { ...RANGE })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listForCustomer('ghost', { ...RANGE })).rejects.toMatchObject({
      response: { code: 'Customers.NotFound' },
    });
    // Short-circuits before any wallet/transaction read.
    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty first page (totalPages floored to 1) when the customer owns no wallet', async () => {
    const { prisma, findMany } = makePrisma({ wallets: [] });
    const service = new CustomerTransactionsService(prisma as never);

    const result = await service.listForCustomer('customer-1', { ...RANGE, 'page[size]': '10' });

    expect(result.data).toEqual([]);
    expect(result.page).toEqual({ number: 1, size: 10, totalItems: 0, totalPages: 1 });
    // No transaction query is issued at all.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('omits the kind/status/currency filters when they are not supplied', async () => {
    const { prisma, findMany, count } = makePrisma({ rows: [txRow()], count: 1 });
    const service = new CustomerTransactionsService(prisma as never);

    await service.listForCustomer('customer-1', { ...RANGE });

    const where = findMany.mock.calls[0][0].where;
    // The entry filter has no currency key; no kind/status keys on the transaction where.
    expect(where.entries.some).toEqual({ walletId: { in: ['wallet-1'] } });
    expect(where).not.toHaveProperty('kind');
    expect(where).not.toHaveProperty('status');
    expect(count).toHaveBeenCalled();
  });

  it('applies the kind, status and currency filters when supplied', async () => {
    const { prisma, findMany } = makePrisma({ rows: [txRow()], count: 1 });
    const service = new CustomerTransactionsService(prisma as never);

    await service.listForCustomer('customer-1', {
      ...RANGE,
      'filter[kind]': 'TRANSFER',
      'filter[status]': 'POSTED',
      'filter[currency]': 'USD',
    });

    const where = findMany.mock.calls[0][0].where;
    expect(where.kind).toBe('TRANSFER');
    expect(where.status).toBe('POSTED');
    expect(where.entries.some).toEqual({ walletId: { in: ['wallet-1'] }, currency: 'USD' });
  });

  it('serializes a CREDIT entry as a POSITIVE signed net', async () => {
    const { prisma } = makePrisma({ rows: [txRow({ entries: [{ leg: 'CREDIT', amountMinor: 7_000n, currency: 'USD' }] })], count: 1 });
    const service = new CustomerTransactionsService(prisma as never);

    const result = await service.listForCustomer('customer-1', { ...RANGE });
    expect(result.data[0].amountMinor).toBe('7000');
    expect(result.data[0].currency).toBe('USD');
  });

  it('serializes a DEBIT entry as a NEGATIVE signed net', async () => {
    const { prisma } = makePrisma({ rows: [txRow({ entries: [{ leg: 'DEBIT', amountMinor: 7_000n, currency: 'USD' }] })], count: 1 });
    const service = new CustomerTransactionsService(prisma as never);

    const result = await service.listForCustomer('customer-1', { ...RANGE });
    expect(result.data[0].amountMinor).toBe('-7000');
  });

  it('handles a transaction with no customer-scoped entry (zero net, empty currency, null postedAt)', async () => {
    const { prisma } = makePrisma({
      rows: [txRow({ entries: [], postedAt: null, description: null })],
      count: 1,
    });
    const service = new CustomerTransactionsService(prisma as never);

    const result = await service.listForCustomer('customer-1', { ...RANGE });
    expect(result.data[0].amountMinor).toBe('0');
    expect(result.data[0].currency).toBe('');
    expect(result.data[0].postedAt).toBeNull();
    expect(result.data[0].description).toBeNull();
  });

  it('computes totalPages from totalItems and the page size (ceil)', async () => {
    const { prisma } = makePrisma({ rows: [txRow()], count: 23 });
    const service = new CustomerTransactionsService(prisma as never);

    const result = await service.listForCustomer('customer-1', { ...RANGE, 'page[size]': '10', 'page[number]': '2' });
    expect(result.page).toEqual({ number: 2, size: 10, totalItems: 23, totalPages: 3 });
  });
});
