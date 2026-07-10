/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { AppErrorService } from '@core/services/app-error.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import { environment } from '../../../environments/environment';

/** Guarded (non-auth-entry) API requests can recover from a 401 via the auth interceptor's refresh. */
function isRecoverableApi401(err: HttpErrorResponse, url: string): boolean {
  return (
    err.status === 401 &&
    url.startsWith(environment.apiBaseUrl) &&
    !/\/auth\/(login|refresh|logout)/.test(url)
  );
}

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const errorService = inject(AppErrorService);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      // Web3 JSON-RPC reads are best-effort: Web3Service retries and degrades
      // gracefully, so transient RPC failures must not raise global error toasts/logs.
      if (req.url.startsWith(environment.web3.rpcUrl)) {
        return throwError(() => err);
      }

      // On the error path the innermost interceptor runs first, so this catch fires BEFORE
      // `authInterceptor` gets to call `auth.refresh()`. A 401 on a guarded API call is
      // recoverable — emitting `errors.sessionExpired` here would flash a misleading
      // "session expired" toast even when the silent refresh succeeds. Defer such 401s to
      // `authInterceptor`, which owns refresh and surfaces expiry only when refresh actually
      // fails. Genuine expiry is still notified: when refresh fails, the `/auth/refresh` call
      // itself 401s and — being an auth-entry path (excluded below) — toasts `sessionExpired`
      // through this same interceptor, after which `authInterceptor` logs out and redirects.
      // Auth-entry 401s and all non-401 errors (403/404/5xx/network) are handled here unchanged.
      // The bootstrap auth probe (`app.config` silent refresh) marks itself SILENT_REQUEST: a 401 or
      // network failure there only means "no session yet", so it must not flash a global error toast on
      // the login screen. Every other error notifies exactly as before —
      // including genuine mid-session expiry, whose interceptor-triggered refresh is NOT silent.
      if (!isRecoverableApi401(err, req.url) && !req.context.get(SILENT_REQUEST)) {
        errorService.handleHttpError(err, req.url);
      }
      return throwError(() => err);
    }),
  );
};
