/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { AppErrorService } from '@core/services/app-error.service';

class ToastMock {
  error = vi.fn();
}
class LoggerMock {
  error = vi.fn();
}
class TranslateMock {
  instant = vi.fn((key: string) => key);
}

describe('AppErrorService', () => {
  it('maps http status to message keys and toasts', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({ status: 400, url: '/test' });
    service.handleHttpError(err);

    expect(logger.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('errors.validation');
  });

  it('handles network and server errors', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleHttpError(new HttpErrorResponse({ status: 0 }));
    service.handleHttpError(new HttpErrorResponse({ status: 500 }));

    expect(toast.error).toHaveBeenCalledWith('errors.network');
    expect(toast.error).toHaveBeenCalledWith('errors.server');
  });

  it('maps unknown http status to default message', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleHttpError(new HttpErrorResponse({ status: 418 }));
    expect(toast.error).toHaveBeenCalledWith('errors.unknown');
  });

  it('maps 401/403/409 to distinct message keys', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleHttpError(new HttpErrorResponse({ status: 401, url: '/a' }));
    service.handleHttpError(new HttpErrorResponse({ status: 403, url: '/b' }));
    service.handleHttpError(new HttpErrorResponse({ status: 409, url: '/c' }));

    expect(toast.error).toHaveBeenCalledWith('errors.sessionExpired');
    expect(toast.error).toHaveBeenCalledWith('errors.forbidden');
    expect(toast.error).toHaveBeenCalledWith('errors.conflict');
  });

  it('maps 429 throttle to errors.tooManyRequests', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock(); // echoes keys → no errors.code.Throttler translation registered
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    // API-009 write throttle: HTTP 429 with envelope code `Throttler` (no code-keyed copy) must land
    // on the dedicated bucket, not fall through to errors.unknown.
    const err = new HttpErrorResponse({
      status: 429,
      url: '/customers',
      error: { error: { code: 'Throttler', message: 'rate limited' } },
    });
    service.handleHttpError(err);

    expect(toast.error).toHaveBeenCalledWith('errors.tooManyRequests');
  });

  it('prefers a code-keyed message when a translation exists', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    // Resolve only the code-specific key; echo everything else (mirrors ngx-translate fallback).
    const i18n = {
      instant: vi.fn((key: string) =>
        key === 'errors.code.Wallets.Conflict' ? 'Reload and retry' : key,
      ),
    };
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({
      status: 409,
      url: '/wallets/1',
      error: { error: { code: 'Wallets.Conflict', message: 'stale', correlationId: 'abc' } },
    });
    service.handleHttpError(err);

    expect(toast.error).toHaveBeenCalledWith('Reload and retry');
  });

  it('logs only safe HTTP error metadata and never the raw error body', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({
      status: 400,
      url: '/customers',
      error: {
        error: {
          code: 'Validation.Failed',
          message: 'invalid customer',
          correlationId: 'corr-123456',
          details: {
            email: 'operator@example.com',
            nationalId: '12345678901',
            address: 'Example Street',
          },
        },
      },
    });
    service.handleHttpError(err);

    expect(logger.error).toHaveBeenCalledWith('HTTP error', {
      url: undefined,
      status: 400,
      error: {
        code: 'Validation.Failed',
        correlationId: 'corr-123456',
        hasDetails: true,
      },
      context: undefined,
    });
  });

  it('falls back to the status bucket for an unknown error code', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock(); // echoes every key → no code translation registered
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({
      status: 409,
      url: '/wallets/2',
      error: { error: { code: 'Wallets.Mystery', message: 'x' } },
    });
    service.handleHttpError(err);

    expect(toast.error).toHaveBeenCalledWith('errors.conflict');
  });

  it('A3: appends a SHORT support reference on a generic fallback (never the raw full id)', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    // Render the suffix with its param so the assertion sees the actual copy shape.
    const i18n = {
      instant: vi.fn((key: string, params?: Record<string, unknown>) =>
        key === 'errors.referenceSuffix' ? ` (Ref: ${params?.['id']})` : key,
      ),
    };
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({
      status: 403,
      url: '/x',
      error: {
        error: { code: 'Auth.Mystery', message: 'no', correlationId: 'abcd1234-rest-of-uuid' },
      },
    });
    service.handleHttpError(err);

    const shown = toast.error.mock.calls.map(c => String(c[0])).join('|');
    // Only the first 8 chars ride along — the full correlation id is never surfaced.
    expect(shown).toContain('errors.forbidden (Ref: abcd1234)');
    expect(shown).not.toContain('rest-of-uuid');
  });

  it('A3: a translated domain-coded message stays clean (no reference suffix)', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = {
      instant: vi.fn((key: string) =>
        key === 'errors.code.Wallets.Conflict' ? 'Reload and retry' : key,
      ),
    };
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({
      status: 409,
      url: '/wallets/9',
      error: { error: { code: 'Wallets.Conflict', message: 'stale', correlationId: 'abcd1234-x' } },
    });
    service.handleHttpError(err);

    expect(toast.error).toHaveBeenCalledWith('Reload and retry');
  });

  it('dedupes identical toasts in a short window', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    const err = new HttpErrorResponse({ status: 404, url: '/x' });
    service.handleHttpError(err);
    service.handleHttpError(err);

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('extractApiError ignores malformed envelopes and silent context suppresses the toast', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleHttpError(
      new HttpErrorResponse({ status: 400, error: { error: 'not-an-envelope' } }),
      '/customers',
      { silent: true },
    );

    expect(logger.error).toHaveBeenCalledWith('HTTP error', {
      url: '/customers',
      status: 400,
      error: {
        code: undefined,
        correlationId: undefined,
        hasDetails: false,
      },
      context: { silent: true },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('handles unknown errors', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleUnknownError(new Error('oops'));
    expect(logger.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('errors.unknown');
  });

  it('handleError delegates http errors', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);
    const err = new HttpErrorResponse({ status: 404, url: '/x' });
    service.handleError(err);
    expect(toast.error).toHaveBeenCalledWith('errors.notFound');
  });

  it('handleError routes non-http errors to unknown handler', () => {
    const toast = new ToastMock();
    const logger = new LoggerMock();
    const i18n = new TranslateMock();
    const service = new AppErrorService(toast as any, logger as any, i18n as any);

    service.handleError('boom');
    expect(logger.error).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('errors.unknown');
  });
});
