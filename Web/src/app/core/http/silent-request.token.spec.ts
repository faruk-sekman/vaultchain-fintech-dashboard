/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpContext } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { SILENT_REQUEST } from './silent-request.token';

describe('SILENT_REQUEST', () => {
  it('defaults to false and can be explicitly enabled per request context', () => {
    const context = new HttpContext();

    expect(context.get(SILENT_REQUEST)).toBe(false);
    expect(context.set(SILENT_REQUEST, true).get(SILENT_REQUEST)).toBe(true);
  });
});
