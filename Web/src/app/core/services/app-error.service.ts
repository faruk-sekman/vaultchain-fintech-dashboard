/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { LoggerService } from '@core/services/logger.service';
import { ToastService } from '@core/services/toast.service';

export interface AppErrorEvent {
  messageKey: string;
  status?: number;
  url?: string;
  detail?: unknown;
  createdAt: number;
  /** Backend correlation id — shown (shortened) on generic fallbacks so support can trace (A3). */
  correlationId?: string;
}

export interface AppErrorContext {
  source?: string;
  operation?: string;
  silent?: boolean;
}

/**
 * Standard backend error envelope: `{ error: { code, message, correlationId, details? } }`.
 * Every field is treated as untrusted (validate-before-use at the HTTP boundary).
 */
export interface ApiErrorEnvelope {
  code?: unknown;
  message?: unknown;
  correlationId?: unknown;
  details?: unknown;
}

/** Narrows the unparsed `HttpErrorResponse.error` body to the envelope shape, when present. */
export function extractApiError(body: unknown): ApiErrorEnvelope | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const inner = (body as { error: unknown }).error;
    if (inner && typeof inner === 'object') {
      return inner as ApiErrorEnvelope;
    }
  }
  return undefined;
}

@Injectable({ providedIn: 'root' })
export class AppErrorService {
  private lastToastSignature: string | null = null;
  private lastToastAt = 0;
  private readonly dedupeWindowMs = 1200;

  constructor(
    private readonly toast: ToastService,
    private readonly logger: LoggerService,
    private readonly i18n: TranslateService,
  ) {}

  handleError(error: unknown, context?: AppErrorContext) {
    if (error instanceof HttpErrorResponse) {
      this.handleHttpError(error, error.url ?? undefined, context);
      return;
    }
    this.handleUnknownError(error, context);
  }

  handleHttpError(err: HttpErrorResponse, url?: string, context?: AppErrorContext) {
    const envelope = extractApiError(err.error);
    const messageKey = this.messageKeyForHttp(err.status, envelope);
    const correlationId =
      typeof envelope?.correlationId === 'string' ? envelope.correlationId : undefined;

    this.logger.error('HTTP error', {
      url,
      status: err.status,
      error: {
        code: typeof envelope?.code === 'string' ? envelope.code : undefined,
        correlationId,
        hasDetails: envelope?.details !== undefined,
      },
      context,
    });
    this.emitError(
      {
        messageKey,
        status: err.status,
        url,
        detail: err.error,
        createdAt: Date.now(),
        correlationId,
      },
      context,
    );
  }

  /**
   * Prefer an i18n message keyed by the backend `error.code` (e.g. `errors.code.Wallets.Conflict`)
   * when a translation exists; otherwise fall back to the HTTP-status bucket. The raw
   * `correlationId`/internal envelope is never surfaced to the operator (only logged above).
   */
  private messageKeyForHttp(status: number, envelope?: ApiErrorEnvelope): string {
    const code = typeof envelope?.code === 'string' ? envelope.code.trim() : '';
    if (code) {
      const candidate = `errors.code.${code}`;
      // `instant` echoes the key back when no translation is registered — treat that as "no copy".
      if (this.i18n.instant(candidate) !== candidate) {
        return candidate;
      }
    }
    return this.httpMessageKey(status);
  }

  handleUnknownError(error: unknown, context?: AppErrorContext) {
    const messageKey = 'errors.unknown';
    this.logger.error('Unhandled UI error', { error, context });
    this.emitError({ messageKey, detail: error, createdAt: Date.now() }, context);
  }

  private emitError(event: AppErrorEvent, context?: AppErrorContext) {
    const signature = this.errorSignature(event);
    const now = Date.now();
    if (!context?.silent) {
      const shouldToast = !(
        this.lastToastSignature === signature && now - this.lastToastAt < this.dedupeWindowMs
      );
      if (shouldToast) {
        this.toast.error(this.toastText(event));
        this.lastToastSignature = signature;
        this.lastToastAt = now;
      }
    }
  }

  /**
   * Toast copy for an error event. When the message is a GENERIC fallback (an HTTP-status bucket,
   * not a translated `errors.code.*` domain message) and the envelope carried a correlationId, a
   * short support reference is appended so the operator can quote it (A3: kod → status → generic
   * (+correlationId display)). Domain-coded messages stay clean — they are already specific.
   */
  private toastText(event: AppErrorEvent): string {
    const base = this.i18n.instant(event.messageKey);
    if (!event.correlationId || event.messageKey.startsWith('errors.code.')) return base;
    const id = event.correlationId.slice(0, 8);
    return `${base}${this.i18n.instant('errors.referenceSuffix', { id })}`;
  }

  private httpMessageKey(status: number): string {
    if (status === 400) return 'errors.validation';
    if (status === 0) return 'errors.network';
    if (status === 401) return 'errors.sessionExpired';
    if (status === 403) return 'errors.forbidden';
    if (status === 404) return 'errors.notFound';
    if (status === 409) return 'errors.conflict';
    // API-009 write throttle returns HTTP 429 with envelope code `Throttler` (no registered
    // errors.code.Throttler key), so without this branch it would fall through to errors.unknown.
    if (status === 429) return 'errors.tooManyRequests';
    if (status >= 500) return 'errors.server';
    return 'errors.unknown';
  }

  private errorSignature(event: AppErrorEvent): string {
    const status = event.status ?? '';
    if (event.status === 0) return `${event.messageKey}|${status}`;
    return `${event.messageKey}|${status}|${event.url ?? ''}`;
  }
}
