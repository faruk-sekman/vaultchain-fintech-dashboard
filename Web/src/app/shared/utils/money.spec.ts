/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the shared minor-unit money helpers (audit D5).
 */
import { describe, it, expect } from 'vitest';
import { MINOR_UNIT_SCALE, minorToMajor, majorToMinor, parseMinor } from './money';

describe('money', () => {
  it('exposes the scale-2 minor-unit factor', () => {
    expect(MINOR_UNIT_SCALE).toBe(100);
  });

  describe('parseMinor (wire string → number)', () => {
    it('parses a positive integer minor-unit string', () => {
      expect(parseMinor('1234500')).toBe(1234500);
      expect(parseMinor('0')).toBe(0);
    });

    it('parses a negative (signed) integer minor-unit string', () => {
      expect(parseMinor('-40000')).toBe(-40000);
    });

    it('rejects non-integer, empty, and non-numeric strings', () => {
      expect(() => parseMinor('')).toThrow(RangeError);
      expect(() => parseMinor('12.50')).toThrow(RangeError);
      expect(() => parseMinor('1e3')).toThrow(RangeError);
      expect(() => parseMinor('abc')).toThrow(RangeError);
      expect(() => parseMinor(' 100 ')).toThrow(RangeError);
      expect(() => parseMinor('+100')).toThrow(RangeError);
    });

    it('rejects values beyond the safe JS integer range instead of truncating', () => {
      // 2^53 = 9007199254740992 is the first unsafe magnitude.
      expect(() => parseMinor('9007199254740992')).toThrow(RangeError);
    });

    it('names the field in the thrown error', () => {
      expect(() => parseMinor('x', 'balanceMinor')).toThrow(/balanceMinor/);
    });

    it('round-trips through minorToMajor for display parity', () => {
      expect(minorToMajor(parseMinor('123450'))).toBe(1234.5);
    });
  });

  it('converts minor units to major', () => {
    expect(minorToMajor(12500)).toBe(125);
    expect(minorToMajor(0)).toBe(0);
    expect(minorToMajor(-9999)).toBe(-99.99);
  });

  it('converts major units to integer minor (rounded)', () => {
    expect(majorToMinor(125)).toBe(12500);
    expect(majorToMinor(99.99)).toBe(9999);
    expect(majorToMinor(0.1)).toBe(10);
  });

  it('honours a non-scale-2 currency scale (FESCALE-001: no hardcoded ÷/×100)', () => {
    // JPY-like (scale 0 → ×1) and KWD-like (scale 3 → ×1000).
    expect(minorToMajor(5000, 0)).toBe(5000);
    expect(minorToMajor(5000, 3)).toBe(5);
    expect(majorToMinor(5000, 0)).toBe(5000);
    expect(majorToMinor(5, 3)).toBe(5000);
  });
});
