/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for parseTxListQuery that complement
 * customer-transactions.query.spec.ts. These pin the remaining branches in the shared `read`
 * coercion helper (array vs non-string-array vs non-string scalar), the `positiveInt` guards on
 * page[number] (not just page[size]), and the `parseSort` all-empty-token fallback to the default.
 */
import { BadRequestException } from '@nestjs/common';
import { parseTxListQuery } from './customer-transactions.query';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-31T00:00:00.000Z';
const RANGE = { 'filter[occurredFrom]': FROM, 'filter[occurredTo]': TO };

function expectBadRequest(raw: Record<string, unknown>): void {
  expect(() => parseTxListQuery(raw)).toThrow(BadRequestException);
}

describe('parseTxListQuery — coercion + guard branches', () => {
  describe('read() value coercion', () => {
    it('uses the first element of a string array param', () => {
      const result = parseTxListQuery({ ...RANGE, 'page[number]': ['3', '4'] });
      expect(result.page).toBe(3);
    });

    it('treats an array whose first element is not a string as undefined (falls back to default)', () => {
      // page[number] is [ {} ] → read() returns undefined → default 1.
      const result = parseTxListQuery({ ...RANGE, 'page[number]': [{ not: 'a string' }] as unknown as string[] });
      expect(result.page).toBe(1);
    });

    it('coerces a non-string scalar via String(v) for currency', () => {
      // A numeric currency value is stringified by read(); "840" is then a 3-char currency.
      const result = parseTxListQuery({ ...RANGE, 'filter[currency]': 840 as unknown as string });
      expect(result.currency).toBe('840');
    });

    it('treats null as undefined (default page size)', () => {
      const result = parseTxListQuery({ ...RANGE, 'page[size]': null as unknown as string });
      expect(result.size).toBe(25);
    });
  });

  describe('positiveInt guards on page[number]', () => {
    it('rejects a non-numeric page[number]', () => {
      expectBadRequest({ ...RANGE, 'page[number]': 'abc' });
    });

    it('rejects a zero page[number] (< 1)', () => {
      expectBadRequest({ ...RANGE, 'page[number]': '0' });
    });

    it('rejects an unsafe-integer page[number]', () => {
      expectBadRequest({ ...RANGE, 'page[number]': '99999999999999999999' });
    });

    it('accepts a blank page[number] as the default (1)', () => {
      expect(parseTxListQuery({ ...RANGE, 'page[number]': '   ' }).page).toBe(1);
    });
  });

  describe('parseSort all-empty-token fallback', () => {
    it('defaults to occurredAt desc when every token is empty (commas only)', () => {
      expect(parseTxListQuery({ ...RANGE, sort: ',,,' }).orderBy).toEqual([{ occurredAt: 'desc' }]);
    });

    it('parses a single descending token', () => {
      expect(parseTxListQuery({ ...RANGE, sort: '-createdAt' }).orderBy).toEqual([{ createdAt: 'desc' }]);
    });
  });
});
