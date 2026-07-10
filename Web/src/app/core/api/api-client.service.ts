/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, throwError, timer } from 'rxjs';
import { catchError, retry, timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { HttpParamsInput, toHttpParams } from '@shared/utils/http-params.util';

const GET_RETRY_DELAY_MS = 350;
/** Single source for the per-request timeout ceiling (re-audit op-fe-timeout-literal). */
const REQUEST_TIMEOUT_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class ApiClientService {
  constructor(private readonly http: HttpClient) {}

  get<T>(path: string, params?: HttpParamsInput): Observable<T> {
    return this.http.get<T>(this.url(path), { params: toHttpParams(params) }).pipe(
      timeout({ first: REQUEST_TIMEOUT_MS }),
      // Retry transient failures (5xx / network / timeout) twice, but NOT a 404 — a missing resource
      // will not appear on retry, so retrying only delays the error (audit
      // ops-retry-on-404). Throwing from `delay` stops the retry and surfaces the original error.
      retry({
        count: 2,
        delay: (error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 404) {
            return throwError(() => error);
          }
          return timer(GET_RETRY_DELAY_MS);
        },
      }),
      catchError(e => throwError(() => e)),
    );
  }

  /**
   * `withCredentials` is opt-in (default off): only the 3 `/auth/*` cookie endpoints set it so the
   * browser sends/receives the httpOnly refresh cookie. Normal protected calls use
   * the Bearer header and must NOT send credentials.
   */
  post<T>(
    path: string,
    body: unknown,
    opts?: { withCredentials?: boolean; headers?: Record<string, string>; context?: HttpContext },
  ): Observable<T> {
    // withCredentials:false is HttpClient's default, so only pass the options object for the
    // opt-in cookie/header/context endpoints; normal posts keep the unchanged 2-arg call.
    const request =
      opts?.withCredentials || opts?.headers || opts?.context
        ? this.http.post<T>(this.url(path), body, {
            ...(opts.withCredentials ? { withCredentials: true } : {}),
            ...(opts.headers ? { headers: opts.headers } : {}),
            ...(opts.context ? { context: opts.context } : {}),
          })
        : this.http.post<T>(this.url(path), body);
    return request.pipe(
      timeout({ first: REQUEST_TIMEOUT_MS }),
      catchError(e => throwError(() => e)),
    );
  }

  put<T>(path: string, body: unknown): Observable<T> {
    return this.http.put<T>(this.url(path), body).pipe(
      timeout({ first: REQUEST_TIMEOUT_MS }),
      catchError(e => throwError(() => e)),
    );
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body).pipe(
      timeout({ first: REQUEST_TIMEOUT_MS }),
      catchError(e => throwError(() => e)),
    );
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path)).pipe(
      timeout({ first: REQUEST_TIMEOUT_MS }),
      catchError(e => throwError(() => e)),
    );
  }

  private url(path: string): string {
    let p = path;
    if (!path.startsWith('/')) {
      p = `/${path}`;
    }
    return `${environment.apiBaseUrl}${p}`;
  }
}
