/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseCustomerListQuery (audit 9C). Pure parsing/validation — no DB. Covers the
 * pagination/size bounds, the q trim+truncate, the kyc/status enum guards, the active taxonomy,
 * and the sort whitelist, including every 400 path.
 */
import { BadRequestException } from '@nestjs/common';
import { CustomerStatus, KycStatus } from '@prisma/client';
import { parseCustomerListQuery, parseReveal } from './customers.query';

const VALID_KYC = Object.keys(KycStatus)[0];
const VALID_STATUS = Object.keys(CustomerStatus)[0];

/** Asserts the parse throws a 400 with the standard error-envelope code. */
function expectBadRequest(raw: Record<string, unknown>): void {
  expect(() => parseCustomerListQuery(raw)).toThrow(BadRequestException);
}

describe('parseCustomerListQuery', () => {
  it('applies defaults for an empty query', () => {
    const result = parseCustomerListQuery({});
    expect(result).toEqual({
      page: 1,
      size: 25,
      q: undefined,
      kycStatus: undefined,
      status: undefined,
      active: undefined,
      reveal: false,
      orderBy: [{ updatedAt: 'desc' }],
    });
  });

  describe('pagination', () => {
    it('parses valid page[number] and page[size]', () => {
      const result = parseCustomerListQuery({ 'page[number]': '3', 'page[size]': '50' });
      expect(result.page).toBe(3);
      expect(result.size).toBe(50);
    });

    it('treats empty/whitespace as the default', () => {
      const result = parseCustomerListQuery({ 'page[number]': '   ', 'page[size]': '' });
      expect(result.page).toBe(1);
      expect(result.size).toBe(25);
    });

    it.each(['0', '-1', 'abc', '1.5', '12a'])('rejects non-positive-integer page[number]=%s', value => {
      expectBadRequest({ 'page[number]': value });
    });

    it('rejects page[size] over the 100 cap', () => {
      expectBadRequest({ 'page[size]': '101' });
    });

    it('accepts page[size] exactly at the 100 cap', () => {
      expect(parseCustomerListQuery({ 'page[size]': '100' }).size).toBe(100);
    });

    it('rejects an unsafe-integer page[number]', () => {
      expectBadRequest({ 'page[number]': '99999999999999999999' });
    });
  });

  describe('filter[q]', () => {
    it('trims and keeps a normal search term', () => {
      expect(parseCustomerListQuery({ 'filter[q]': '  ada  ' }).q).toBe('ada');
    });

    it('truncates to 120 chars', () => {
      const long = 'x'.repeat(200);
      expect(parseCustomerListQuery({ 'filter[q]': long }).q).toHaveLength(120);
    });

    it('treats a blank term as undefined', () => {
      expect(parseCustomerListQuery({ 'filter[q]': '   ' }).q).toBeUndefined();
    });
  });

  describe('enum filters', () => {
    it('accepts a valid kycStatus and status', () => {
      const result = parseCustomerListQuery({
        'filter[kycStatus]': VALID_KYC,
        'filter[status]': VALID_STATUS,
      });
      expect(result.kycStatus).toBe(VALID_KYC);
      expect(result.status).toBe(VALID_STATUS);
    });

    it('rejects an invalid kycStatus', () => {
      expectBadRequest({ 'filter[kycStatus]': 'NOT_A_STATUS' });
    });

    it('rejects an invalid status', () => {
      expectBadRequest({ 'filter[status]': 'NOT_A_STATUS' });
    });
  });

  describe('filter[active] taxonomy', () => {
    it.each([
      ['true', true],
      ['false', false],
      ['yes', undefined],
      [undefined, undefined],
    ])('maps active=%s -> %s', (input, expected) => {
      const raw = input === undefined ? {} : { 'filter[active]': input };
      expect(parseCustomerListQuery(raw).active).toBe(expected);
    });
  });

  describe('sort whitelist', () => {
    it('defaults to updatedAt desc when sort is absent or blank', () => {
      expect(parseCustomerListQuery({ sort: '  ' }).orderBy).toEqual([{ updatedAt: 'desc' }]);
    });

    it('parses an ascending field', () => {
      expect(parseCustomerListQuery({ sort: 'fullName' }).orderBy).toEqual([{ fullName: 'asc' }]);
    });

    it('parses a descending field (leading -)', () => {
      expect(parseCustomerListQuery({ sort: '-createdAt' }).orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('parses multiple comma-separated fields and skips empties', () => {
      expect(parseCustomerListQuery({ sort: 'fullName,,-updatedAt' }).orderBy).toEqual([
        { fullName: 'asc' },
        { updatedAt: 'desc' },
      ]);
    });

    it('rejects a field not on the whitelist', () => {
      expectBadRequest({ sort: 'email' });
    });
  });

  describe('reveal (strict bi-state)', () => {
    it('parses reveal=true into the query as a boolean true', () => {
      expect(parseCustomerListQuery({ reveal: 'true' }).reveal).toBe(true);
    });

    it('defaults reveal to false when absent', () => {
      expect(parseCustomerListQuery({}).reveal).toBe(false);
    });

    it.each(['true', ' true ', 'TRUE', '1', 'false', '', 'yes', undefined])(
      'parseReveal(%s) is true ONLY for the trimmed literal "true"',
      value => {
        expect(parseReveal(value)).toBe(value?.trim() === 'true');
      },
    );
  });

  describe('readString coercion', () => {
    it('reads the first element of an array param', () => {
      expect(parseCustomerListQuery({ 'filter[q]': ['needle', 'other'] }).q).toBe('needle');
    });

    it('coerces a non-string scalar to string', () => {
      // numeric page value arriving as a number still parses
      expect(parseCustomerListQuery({ 'page[number]': 2 as unknown as string }).page).toBe(2);
    });
  });
});
