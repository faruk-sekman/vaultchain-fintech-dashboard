/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, expect, it } from 'vitest';

import { routeFade } from './route-animations';

describe('routeFade', () => {
  it('exposes the named route transition trigger used by the main layout', () => {
    expect(routeFade.name).toBe('routeFade');
    expect(routeFade.definitions.length).toBeGreaterThan(0);
  });
});
