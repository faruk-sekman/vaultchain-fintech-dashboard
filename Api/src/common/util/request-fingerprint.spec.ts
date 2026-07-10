/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { canonicalize, fingerprintRequest } from './request-fingerprint';

describe('request-fingerprint', () => {
  it('is independent of key order', () => {
    const a = fingerprintRequest({ amountMinor: 100, currency: 'TRY' });
    const b = fingerprintRequest({ currency: 'TRY', amountMinor: 100 });
    expect(a).toBe(b);
  });

  it('drops null/undefined optional fields (same as omitting them)', () => {
    const withNull = fingerprintRequest({ amountMinor: 100, description: null });
    const without = fingerprintRequest({ amountMinor: 100 });
    expect(withNull).toBe(without);
  });

  it('differs when a meaningful value differs', () => {
    expect(fingerprintRequest({ amountMinor: 100 })).not.toBe(fingerprintRequest({ amountMinor: 101 }));
  });

  it('canonicalizes nested objects deterministically', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
