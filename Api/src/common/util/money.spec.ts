/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the money wire-boundary helpers: the safe-number narrowing (audit O-10) and the
 * canonical wire-string serializer (audit O-10).
 */
import { majorToMinor, minorToSafeNumber, minorToWireString } from './money';

describe('minorToSafeNumber', () => {
  it('returns the exact number for in-range values', () => {
    expect(minorToSafeNumber(0n)).toBe(0);
    expect(minorToSafeNumber(123_456n, 'balanceMinor')).toBe(123456);
    expect(minorToSafeNumber(-50_000n, 'amountMinor')).toBe(-50000);
  });

  it('accepts the exact safe-integer boundaries', () => {
    expect(minorToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(minorToSafeNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('throws (never truncates) just above MAX_SAFE_INTEGER, naming the field', () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => minorToSafeNumber(tooBig, 'balanceMinor')).toThrow(/balanceMinor/);
    expect(() => minorToSafeNumber(tooBig)).toThrow(RangeError);
  });

  it('throws just below MIN_SAFE_INTEGER', () => {
    expect(() => minorToSafeNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toThrow(RangeError);
  });
});

describe('minorToWireString', () => {
  it('serializes a BigInt to the exact decimal string', () => {
    expect(minorToWireString(0n)).toBe('0');
    expect(minorToWireString(1_234_500n, 'balanceMinor')).toBe('1234500');
    expect(minorToWireString(-40_000n, 'amountMinor')).toBe('-40000');
  });

  it('stays exact ABOVE the JS safe-integer range (the whole point of the string wire-format)', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) * 1_000n + 7n;
    expect(minorToWireString(huge)).toBe(huge.toString());
  });

  it('serializes an already-narrowed safe-integer number', () => {
    expect(minorToWireString(12_500)).toBe('12500');
    expect(minorToWireString(-50_000, 'amountMinor')).toBe('-50000');
  });

  it('throws on an unsafe/non-integer number input (never serializes a lossy money string)', () => {
    expect(() => minorToWireString(1.5, 'amountMinor')).toThrow(/amountMinor/);
    expect(() => minorToWireString(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe('majorToMinor', () => {
  it('converts scale-2 major units (×100, unchanged from the old hardcoded path)', () => {
    expect(majorToMinor(5_000, 2)).toBe(500_000n);
    expect(majorToMinor(19.99, 2)).toBe(1_999n);
    expect(majorToMinor(0, 2)).toBe(0n);
  });

  it('honours a non-scale-2 currency scale (BE-001: no hardcoded ×100)', () => {
    expect(majorToMinor(5_000, 0)).toBe(5_000n); // JPY-like: scale 0 → ×1
    expect(majorToMinor(5, 3)).toBe(5_000n); // KWD-like: scale 3 → ×1000
  });

  it('throws on a non-finite amount, naming the field', () => {
    expect(() => majorToMinor(Number.NaN, 2, 'dailyLimit')).toThrow(/dailyLimit/);
    expect(() => majorToMinor(Number.POSITIVE_INFINITY, 2)).toThrow(/finite/);
  });

  it('throws when the converted value exceeds the safe integer range', () => {
    expect(() => majorToMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(/safe integer/);
  });
});
