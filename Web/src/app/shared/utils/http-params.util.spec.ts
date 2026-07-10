/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { toHttpParams } from '@shared/utils/http-params.util';

describe('toHttpParams', () => {
  it('returns empty params for undefined', () => {
    const params = toHttpParams(undefined);
    expect(params.toString()).toBe('');
  });

  it('filters null, undefined and empty string values', () => {
    const params = toHttpParams({
      a: 'ok',
      b: '',
      c: null,
      d: undefined,
    });
    expect(params.get('a')).toBe('ok');
    expect(params.get('b')).toBeNull();
    expect(params.get('c')).toBeNull();
    expect(params.get('d')).toBeNull();
  });

  it('stringifies numbers and booleans', () => {
    const params = toHttpParams({ a: 1, b: true, c: false });
    expect(params.get('a')).toBe('1');
    expect(params.get('b')).toBe('true');
    expect(params.get('c')).toBe('false');
  });
});
