/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseTxListQuery (audit 9C). Covers pagination, the REQUIRED + bounded (≤366d) date
 * range, the kind/status enum guards, currency, and the sort whitelist — including every 400 path.
 */
import { BadRequestException } from '@nestjs/common';
import { TransactionKind, TransactionStatus } from '@prisma/client';
import { parseTxListQuery } from './customer-transactions.query';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-31T00:00:00.000Z';
const RANGE = { 'filter[occurredFrom]': FROM, 'filter[occurredTo]': TO };
const VALID_KIND = Object.keys(TransactionKind)[0];
const VALID_STATUS = Object.keys(TransactionStatus)[0];

function expectBadRequest(raw: Record<string, unknown>): void {
  expect(() => parseTxListQuery(raw)).toThrow(BadRequestException);
}

describe('parseTxListQuery', () => {
  it('parses a minimal valid query (range only) with defaults', () => {
    const result = parseTxListQuery({ ...RANGE });
    expect(result.page).toBe(1);
    expect(result.size).toBe(25);
    expect(result.occurredFrom.toISOString()).toBe(FROM);
    expect(result.occurredTo.toISOString()).toBe(TO);
    expect(result.orderBy).toEqual([{ occurredAt: 'desc' }]);
    expect(result.kind).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.currency).toBeUndefined();
  });

  describe('date range (required + bounded)', () => {
    it('rejects a missing occurredFrom or occurredTo', () => {
      expectBadRequest({ 'filter[occurredTo]': TO });
      expectBadRequest({ 'filter[occurredFrom]': FROM });
      expectBadRequest({});
    });

    it('rejects an unparseable date', () => {
      expectBadRequest({ 'filter[occurredFrom]': 'not-a-date', 'filter[occurredTo]': TO });
    });

    it('rejects from > to', () => {
      expectBadRequest({ 'filter[occurredFrom]': TO, 'filter[occurredTo]': FROM });
    });

    it('rejects a range over 366 days', () => {
      expectBadRequest({ 'filter[occurredFrom]': '2025-01-01T00:00:00.000Z', 'filter[occurredTo]': '2026-06-01T00:00:00.000Z' });
    });

    it('accepts a range exactly within 366 days', () => {
      expect(() => parseTxListQuery({ 'filter[occurredFrom]': '2026-01-01T00:00:00.000Z', 'filter[occurredTo]': '2026-12-31T00:00:00.000Z' })).not.toThrow();
    });
  });

  describe('enum + currency filters', () => {
    it('accepts a valid kind, status and currency', () => {
      const result = parseTxListQuery({ ...RANGE, 'filter[kind]': VALID_KIND, 'filter[status]': VALID_STATUS, 'filter[currency]': 'TRY' });
      expect(result.kind).toBe(VALID_KIND);
      expect(result.status).toBe(VALID_STATUS);
      expect(result.currency).toBe('TRY');
    });

    it('rejects an invalid kind or status', () => {
      expectBadRequest({ ...RANGE, 'filter[kind]': 'NOPE' });
      expectBadRequest({ ...RANGE, 'filter[status]': 'NOPE' });
    });

    it('treats a blank currency as undefined', () => {
      expect(parseTxListQuery({ ...RANGE, 'filter[currency]': '  ' }).currency).toBeUndefined();
    });
  });

  describe('pagination + sort', () => {
    it('rejects page[size] over the 100 cap', () => {
      expectBadRequest({ ...RANGE, 'page[size]': '101' });
    });

    it('parses asc, desc, and multiple sort tokens, skipping empties', () => {
      expect(parseTxListQuery({ ...RANGE, sort: 'occurredAt,,-createdAt' }).orderBy).toEqual([
        { occurredAt: 'asc' },
        { createdAt: 'desc' },
      ]);
    });

    it('defaults sort to occurredAt desc when blank', () => {
      expect(parseTxListQuery({ ...RANGE, sort: '   ' }).orderBy).toEqual([{ occurredAt: 'desc' }]);
    });

    it('rejects a non-whitelisted sort field', () => {
      expectBadRequest({ ...RANGE, sort: 'amount' });
    });
  });
});
