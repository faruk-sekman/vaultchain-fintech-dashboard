/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { isUuid, uuidv7 } from './uuid';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('matches the UUIDv7 shape (version 7 + RFC variant)', () => {
    expect(uuidv7()).toMatch(UUID_V7_RE);
  });

  it('is unique across many generations', () => {
    const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(set.size).toBe(1000);
  });

  it('is time-ordered (lexicographically increasing over time)', async () => {
    const first = uuidv7();
    await new Promise((r) => setTimeout(r, 3));
    const second = uuidv7();
    expect(first < second).toBe(true);
  });

  it('is strictly monotonic within a single millisecond and survives 12-bit counter overflow (DATA-004)', () => {
    // Pin Date.now() to a fixed FUTURE ms so every generation lands in the same millisecond (and the
    // module-level state resets cleanly on the first call, since the fixed value exceeds real-now).
    const fixedMs = 2_000_000_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      // 4200 > 4096 forces the 12-bit rand_a counter to overflow into the next logical millisecond.
      const ids = Array.from({ length: 4200 }, () => uuidv7());
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true); // strictly increasing despite an identical Date.now()
      }
      expect(new Set(ids).size).toBe(ids.length); // all unique
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isUuid', () => {
  it('accepts RFC UUID shapes regardless of version', () => {
    expect(isUuid('018f6f46-7a3e-7b9a-9d7f-5d0d938d0abc')).toBe(true);
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('018f6f467a3e7b9a9d7f5d0d938d0abc')).toBe(false);
  });
});
