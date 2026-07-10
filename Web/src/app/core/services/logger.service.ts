/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class LoggerService {
  // Gated on the developer-diagnostics flag (dev only), NOT merely `!production` — so a deployed
  // stage build (production:false) does not ship verbose console logging (re-audit op-stage-devtools).
  private readonly enabled = environment.enableDevtools;

  error(message: string, extra?: unknown) {
    if (!this.enabled) return;
    console.error(
      `[FintechWalletOpsDashboard] ${message}${this.toMessageSuffix(extra)}`,
      this.toLoggable(extra),
    );
  }
  info(message: string, extra?: unknown) {
    if (!this.enabled) return;
    console.info(`[FintechWalletOpsDashboard] ${message}`, this.toLoggable(extra));
  }

  private toLoggable(value: unknown, depth = 0): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack?.split('\n').slice(0, 6).join('\n'),
      };
    }

    if (!value || typeof value !== 'object') return value;
    if (depth >= 2) return '[Object]';

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (this.isSensitiveKey(key)) return [key, '[redacted]'];
        return [key, this.toLoggable(entry, depth + 1)];
      }),
    );
  }

  private isSensitiveKey(key: string): boolean {
    return /token|secret|password|api[-_]?key|authorization|cookie|email|e[-_]?mail|phone|mobile|address|national[-_]?id|nationalid|full[-_]?name|first[-_]?name|last[-_]?name|birth|date[-_]?of[-_]?birth|identity/i.test(
      key,
    );
  }

  private toMessageSuffix(value: unknown): string {
    const error = this.extractError(value);
    if (!error) return '';
    return ` | ${error.name}: ${error.message}`;
  }

  private extractError(value: unknown): Error | null {
    if (value instanceof Error) return value;
    if (!value || typeof value !== 'object') return null;

    const nested = (value as { error?: unknown }).error;
    if (nested instanceof Error) return nested;
    return null;
  }
}
