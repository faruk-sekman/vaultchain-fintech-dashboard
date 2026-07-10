/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { isTurkishNationalId } from './is-turkish-national-id';

describe('isTurkishNationalId', () => {
  it('accepts a checksum-valid 11-digit id', () => {
    expect(isTurkishNationalId('10000000146')).toBe(true); // verified by the official checksum
  });

  it('rejects a wrong checksum', () => {
    expect(isTurkishNationalId('12345678901')).toBe(false);
    expect(isTurkishNationalId('10000000145')).toBe(false); // last digit off by one
  });

  it('rejects a leading zero', () => {
    expect(isTurkishNationalId('01234567890')).toBe(false);
  });

  it('rejects wrong length / non-digits / non-strings', () => {
    expect(isTurkishNationalId('1000000014')).toBe(false); // 10 digits
    expect(isTurkishNationalId('100000001460')).toBe(false); // 12 digits
    expect(isTurkishNationalId('1000000014a')).toBe(false);
    expect(isTurkishNationalId('')).toBe(false);
    expect(isTurkishNationalId(10000000146 as unknown)).toBe(false); // must be a string
    expect(isTurkishNationalId(null)).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(isTurkishNationalId('  10000000146  ')).toBe(true);
  });
});
