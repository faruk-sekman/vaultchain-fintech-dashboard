/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseKycListQuery (audit 9C). Pagination-only parser — defaults, bounds, the 100
 * cap, and every 400 path.
 */
import { BadRequestException } from '@nestjs/common';
import { parseKycListQuery } from './customer-kyc.query';

function expectBadRequest(raw: Record<string, unknown>): void {
  expect(() => parseKycListQuery(raw)).toThrow(BadRequestException);
}

describe('parseKycListQuery', () => {
  it('applies defaults for an empty query', () => {
    expect(parseKycListQuery({})).toEqual({ page: 1, size: 25 });
  });

  it('parses valid paging', () => {
    expect(parseKycListQuery({ 'page[number]': '4', 'page[size]': '10' })).toEqual({ page: 4, size: 10 });
  });

  it('treats blank values as defaults', () => {
    expect(parseKycListQuery({ 'page[number]': '  ', 'page[size]': '' })).toEqual({ page: 1, size: 25 });
  });

  it.each(['0', '-2', 'x', '2.5'])('rejects non-positive-integer page[number]=%s', value => {
    expectBadRequest({ 'page[number]': value });
  });

  it('rejects page[size] over the 100 cap and accepts exactly 100', () => {
    expectBadRequest({ 'page[size]': '101' });
    expect(parseKycListQuery({ 'page[size]': '100' }).size).toBe(100);
  });

  it('rejects an unsafe-integer page value', () => {
    expectBadRequest({ 'page[number]': '99999999999999999999' });
  });

  it('reads the first element of an array param and coerces a scalar', () => {
    expect(parseKycListQuery({ 'page[size]': ['7', '9'] }).size).toBe(7);
    expect(parseKycListQuery({ 'page[number]': 3 as unknown as string }).page).toBe(3);
  });
});
