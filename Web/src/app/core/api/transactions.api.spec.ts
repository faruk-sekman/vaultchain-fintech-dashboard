/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * TransactionsApi mapper coverage. The list call maps the backend
 * `{ data, page }` envelope to `PaginatedResponse<Transaction>`, deriving the displayed credit/debit
 * type + colour from the SIGNED `amountMinor` string (parsed via `parseMinor`, which fails loudly on a
 * malformed/out-of-range money string). `create` attaches the Idempotency-Key header and unwraps the
 * snapshot. These tests drive the real wire-string parsing branches (positive / negative / zero /
 * invalid) and the description fallback (`description ?? publicRef ?? ''`).
 */
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { TransactionsApi } from './transactions.api';
import { ApiClientService } from '@core/api/api-client.service';
import type { PaginatedResponse } from '@shared/models/pagination.model';
import type { Transaction } from '@shared/models/transaction.model';

/** A single backend list item with overridable fields. */
function backendItem(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tx-1',
    publicRef: 'PR-1',
    kind: 'TRANSFER',
    status: 'POSTED',
    amountMinor: '12500',
    currency: 'TRY',
    description: 'Salary',
    occurredAt: '2026-01-01T00:00:00.000Z',
    postedAt: '2026-01-01T00:00:01.000Z',
    ...over,
  };
}

function apiMock(response: unknown) {
  const api = {
    get: vi.fn(() => of(response)),
    post: vi.fn(() => of(response)),
  } as unknown as ApiClientService & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };
  return api;
}

function listOf(items: unknown[]) {
  return { data: items, page: { number: 2, size: 25, totalItems: 51, totalPages: 3 } };
}

describe('TransactionsApi.listByCustomerId', () => {
  it('maps the backend envelope into PaginatedResponse and encodes the customer id in the URL', () => {
    const api = apiMock(listOf([backendItem()]));
    let result: PaginatedResponse<Transaction> | undefined;
    new TransactionsApi(api).listByCustomerId('cust 1', { page: 2, pageSize: 25 }).subscribe(r => {
      result = r;
    });

    // URL-encodes the id and forwards the bracketed page/filter params.
    expect(api.get).toHaveBeenCalledWith(
      '/customers/cust%201/transactions',
      expect.objectContaining({ 'page[number]': 2, 'page[size]': 25 }),
    );
    expect(result?.page).toBe(2);
    expect(result?.pageSize).toBe(25);
    expect(result?.total).toBe(51);
    expect(result?.data).toHaveLength(1);
  });

  it('forwards the full date-range + ledger filter params (kind/status/currency/from/to)', () => {
    const api = apiMock(listOf([]));
    new TransactionsApi(api)
      .listByCustomerId('c1', {
        page: 1,
        pageSize: 10,
        from: '2026-01-01',
        to: '2026-01-31',
        kind: 'TRANSFER' as Transaction['kind'],
        status: 'POSTED' as Transaction['status'],
        currency: 'USD',
      })
      .subscribe();
    expect(api.get).toHaveBeenCalledWith('/customers/c1/transactions', {
      'page[number]': 1,
      'page[size]': 10,
      'filter[occurredFrom]': '2026-01-01',
      'filter[occurredTo]': '2026-01-31',
      'filter[kind]': 'TRANSFER',
      'filter[status]': 'POSTED',
      'filter[currency]': 'USD',
    });
  });

  it('maps a POSITIVE signed amount to a CREDIT / INCOMING with the major-unit amount', () => {
    const api = apiMock(listOf([backendItem({ amountMinor: '12500' })]));
    let tx: Transaction | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (tx = r.data[0]));
    expect(tx?.type).toBe('CREDIT');
    expect(tx?.transferDirection).toBe('INCOMING');
    expect(tx?.amount).toBe(125); // 12500 minor / 100
  });

  it('maps a ZERO amount as a CREDIT (>= 0 boundary, amount 0)', () => {
    const api = apiMock(listOf([backendItem({ amountMinor: '0' })]));
    let tx: Transaction | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (tx = r.data[0]));
    expect(tx?.type).toBe('CREDIT');
    expect(tx?.amount).toBe(0);
  });

  it('maps a NEGATIVE signed amount to a DEBIT / OUTGOING with the absolute major-unit amount', () => {
    const api = apiMock(listOf([backendItem({ amountMinor: '-9900' })]));
    let tx: Transaction | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (tx = r.data[0]));
    expect(tx?.type).toBe('DEBIT');
    expect(tx?.transferDirection).toBe('OUTGOING');
    expect(tx?.amount).toBe(99); // abs(-9900) / 100
  });

  it('falls back description → publicRef → "" (null description uses publicRef)', () => {
    const api = apiMock(listOf([backendItem({ description: null, publicRef: 'PR-9' })]));
    let tx: Transaction | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (tx = r.data[0]));
    expect(tx?.description).toBe('PR-9');
  });

  it('falls back to an empty description when both description and publicRef are null', () => {
    const api = apiMock(listOf([backendItem({ description: null, publicRef: null })]));
    let tx: Transaction | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (tx = r.data[0]));
    expect(tx?.description).toBe('');
  });

  it('FAILS LOUD on a non-integer money string rather than rendering a wrong amount (parseMinor guard)', () => {
    // The throw inside map() surfaces as an error NOTIFICATION; capture it via the error callback.
    const api = apiMock(listOf([backendItem({ amountMinor: '12.50' })]));
    let err: unknown;
    new TransactionsApi(api)
      .listByCustomerId('c1', {})
      .subscribe({ next: () => undefined, error: e => (err = e) });
    expect((err as Error)?.message).toMatch(/amountMinor/);
  });

  it('FAILS LOUD on an out-of-safe-range money string (lossy amount refused)', () => {
    // 2^53 + 1 exceeds Number.MAX_SAFE_INTEGER → parseMinor throws rather than lose precision.
    const api = apiMock(listOf([backendItem({ amountMinor: '9007199254740993' })]));
    let err: unknown;
    new TransactionsApi(api)
      .listByCustomerId('c1', {})
      .subscribe({ next: () => undefined, error: e => (err = e) });
    expect((err as Error)?.message).toMatch(/safe JS integer range/);
  });

  it('returns an empty page unchanged (no items to map)', () => {
    const api = apiMock(listOf([]));
    let result: PaginatedResponse<Transaction> | undefined;
    new TransactionsApi(api).listByCustomerId('c1', {}).subscribe(r => (result = r));
    expect(result?.data).toEqual([]);
    expect(result?.total).toBe(51);
  });
});

describe('TransactionsApi.create', () => {
  it('attaches the Idempotency-Key header and unwraps the snapshot from { data }', () => {
    const snapshot = {
      id: 's1',
      publicRef: 'PR',
      status: 'POSTED' as const,
      amountMinor: '5000',
      currency: 'TRY',
      postedAt: '2026-01-01T00:00:00.000Z',
    };
    const api = apiMock({ data: snapshot });
    let out: unknown;
    new TransactionsApi(api)
      .create(
        {
          kind: 'TRANSFER' as Transaction['kind'],
          amountMinor: 5000,
          currency: 'TRY',
        },
        'idem-key-123',
      )
      .subscribe(r => (out = r));

    expect(api.post).toHaveBeenCalledWith(
      '/transactions',
      expect.objectContaining({ amountMinor: 5000, currency: 'TRY' }),
      { headers: { 'Idempotency-Key': 'idem-key-123' } },
    );
    expect(out).toEqual(snapshot);
  });
});
