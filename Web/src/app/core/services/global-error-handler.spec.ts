/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { GlobalErrorHandler } from '@core/services/global-error-handler';

class AppErrorMock {
  handleUnknownError = vi.fn();
}

describe('GlobalErrorHandler', () => {
  it('delegates errors to AppErrorService', () => {
    const appError = new AppErrorMock();
    const handler = new GlobalErrorHandler(appError as any);

    handler.handleError(new Error('boom'));
    expect(appError.handleUnknownError).toHaveBeenCalled();
  });
});
