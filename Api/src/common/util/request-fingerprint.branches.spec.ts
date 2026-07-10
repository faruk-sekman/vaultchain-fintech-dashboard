/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-completion tests for request-fingerprint. The sibling spec covers key-order
 * independence, null/undefined dropping, value sensitivity, and nested-object canonicalization.
 * This file fills the ARRAY branch of sortValue (arrays preserved in order, elements recursively
 * sorted) plus the primitive/leaf branches and a stable end-to-end fingerprint assertion.
 */
import { canonicalize, fingerprintRequest } from './request-fingerprint';

describe('request-fingerprint — branch completion', () => {
  it('preserves array element ORDER (arrays are positional, not sorted)', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(fingerprintRequest([1, 2])).not.toBe(fingerprintRequest([2, 1]));
  });

  it('recursively canonicalizes objects nested INSIDE arrays', () => {
    expect(canonicalize([{ b: 1, a: 2 }, { d: 4, c: 3 }])).toBe('[{"a":2,"b":1},{"c":3,"d":4}]');
  });

  it('drops null/undefined-valued keys inside array-nested objects too', () => {
    expect(canonicalize([{ amountMinor: 100, note: null }])).toBe('[{"amountMinor":100}]');
  });

  it('handles primitive leaves (string, number, boolean) unchanged', () => {
    expect(canonicalize('TRY')).toBe('"TRY"');
    expect(canonicalize(100)).toBe('100');
    expect(canonicalize(true)).toBe('true');
  });

  it('produces a deterministic, stable SHA-256 hex fingerprint for a known payload', () => {
    const fp = fingerprintRequest({ currency: 'TRY', amountMinor: 100, tags: ['a', 'b'] });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // Same logical request (reordered keys) ⇒ identical fingerprint.
    expect(fp).toBe(fingerprintRequest({ tags: ['a', 'b'], amountMinor: 100, currency: 'TRY' }));
  });

  it('a reordered array tail changes the fingerprint (order is load-bearing)', () => {
    const a = fingerprintRequest({ tags: ['a', 'b'] });
    const b = fingerprintRequest({ tags: ['b', 'a'] });
    expect(a).not.toBe(b);
  });
});
