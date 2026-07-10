/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HttpContext,
  HttpErrorResponse,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { lastValueFrom, of, throwError } from 'rxjs';
import { loadingInterceptor } from '@core/interceptors/loading.interceptor';
import { errorInterceptor } from '@core/interceptors/error.interceptor';
import { authInterceptor } from '@core/interceptors/auth.interceptor';
import { LoadingService } from '@core/services/loading.service';
import { AppErrorService } from '@core/services/app-error.service';
import { AuthService } from '@core/auth/auth.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import { environment } from '../../../environments/environment';

/** A guarded, non-auth-entry API URL (recoverable 401 path) and an auth-entry URL (real expiry). */
const GUARDED_API_URL = `${environment.apiBaseUrl}/dashboard/stream-token`;
const REFRESH_URL = `${environment.apiBaseUrl}/auth/refresh`;
const LOGIN_URL = `${environment.apiBaseUrl}/auth/login`;
const LOGOUT_URL = `${environment.apiBaseUrl}/auth/logout`;

describe('HTTP interceptors', () => {
  const loadingMock = { start: vi.fn(), end: vi.fn() };
  const appErrorMock = { handleHttpError: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: LoadingService, useValue: loadingMock },
        { provide: AppErrorService, useValue: appErrorMock },
      ],
    });
  });

  it('loadingInterceptor toggles loading by default', async () => {
    const req = new HttpRequest('GET', '/test');
    const next = vi.fn(() => of(new HttpResponse({ status: 200 })));

    await TestBed.runInInjectionContext(() => lastValueFrom(loadingInterceptor(req, next)));

    expect(loadingMock.start).toHaveBeenCalled();
    expect(loadingMock.end).toHaveBeenCalled();
  });

  it('loadingInterceptor skips when header present', async () => {
    const req = new HttpRequest('GET', '/test', undefined, {
      headers: new HttpHeaders({ 'x-skip-loading': '1' }),
    });
    const next = vi.fn(() => of(new HttpResponse({ status: 200 })));

    await TestBed.runInInjectionContext(() => lastValueFrom(loadingInterceptor(req, next)));

    expect(loadingMock.start).not.toHaveBeenCalled();
  });

  it('loadingInterceptor still ends loading when the downstream request errors (finalize)', async () => {
    const req = new HttpRequest('GET', '/test');
    const error = new Error('boom');
    const next = vi.fn(() => throwError(() => error));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(loadingInterceptor(req, next))),
    ).rejects.toBe(error);

    expect(loadingMock.start).toHaveBeenCalledTimes(1);
    expect(loadingMock.end).toHaveBeenCalledTimes(1);
  });

  it('errorInterceptor reports errors and rethrows', async () => {
    const req = new HttpRequest('GET', '/test');
    const httpError = new HttpErrorResponse({ status: 500, url: '/test' });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).toHaveBeenCalledWith(httpError, '/test');
  });

  it('errorInterceptor skips web3 RPC failures (handled gracefully by the service)', async () => {
    const req = new HttpRequest('POST', environment.web3.rpcUrl, {});
    const httpError = new HttpErrorResponse({ status: 0, url: environment.web3.rpcUrl });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).not.toHaveBeenCalled();
  });

  // The bootstrap auth probe marks itself SILENT_REQUEST: a 401 there only
  // means "no session yet" and must not flash a global error toast on the login screen.
  it('errorInterceptor does not globally report a SILENT_REQUEST failure (silent bootstrap probe)', async () => {
    const req = new HttpRequest('POST', REFRESH_URL, undefined, {
      context: new HttpContext().set(SILENT_REQUEST, true),
    });
    const httpError = new HttpErrorResponse({ status: 401, url: REFRESH_URL });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).not.toHaveBeenCalled();
  });

  // finding #3b — a guarded (non-auth-entry) 401 is recoverable via authInterceptor's refresh, so
  // errorInterceptor must NOT flash `errors.sessionExpired` here; it defers 401 handling to auth.
  it('errorInterceptor defers a guarded non-auth 401 to authInterceptor (no immediate toast)', async () => {
    const req = new HttpRequest('POST', GUARDED_API_URL, {});
    const httpError = new HttpErrorResponse({ status: 401, url: GUARDED_API_URL });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).not.toHaveBeenCalled();
  });

  // Genuine expiry / login failure: an auth-entry 401 is NOT recoverable, so it must still surface
  // through errorInterceptor (this is the path that toasts `sessionExpired` on real expiry).
  it.each([
    ['refresh', REFRESH_URL],
    ['login', LOGIN_URL],
    ['logout', LOGOUT_URL],
  ])('errorInterceptor still reports an auth-entry 401 (/auth/%s)', async (_name, url) => {
    const req = new HttpRequest('POST', url, {});
    const httpError = new HttpErrorResponse({ status: 401, url });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).toHaveBeenCalledWith(httpError, url);
  });

  // Only 401 is deferred — a guarded 403 (and the 500 above) must still report unchanged.
  it('errorInterceptor reports a guarded non-401 error unchanged (403)', async () => {
    const req = new HttpRequest('POST', GUARDED_API_URL, {});
    const httpError = new HttpErrorResponse({ status: 403, url: GUARDED_API_URL });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(errorInterceptor(req, next))),
    ).rejects.toBe(httpError);

    expect(appErrorMock.handleHttpError).toHaveBeenCalledWith(httpError, GUARDED_API_URL);
  });
});

// The other half of genuine expiry: when authInterceptor's refresh actually fails, the session is
// cleared and the operator is redirected to /login (finding #3b — real expiry is still surfaced).
describe('authInterceptor — refresh-failure redirect', () => {
  const navigate = vi.fn();
  const routerMock = { navigate };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function configure(auth: Partial<AuthService>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: routerMock },
      ],
    });
  }

  it('on a guarded 401, when refresh fails it logs out and redirects to /login', async () => {
    const refreshErr = new HttpErrorResponse({ status: 401, url: REFRESH_URL });
    const logout = vi.fn(() => of(undefined));
    const auth: Partial<AuthService> = {
      getToken: () => 'stale-access-token',
      refresh: () => throwError(() => refreshErr),
      logout: () => logout() as ReturnType<AuthService['logout']>,
    };
    configure(auth);

    const req = new HttpRequest('POST', GUARDED_API_URL, {});
    const httpError = new HttpErrorResponse({ status: 401, url: GUARDED_API_URL });
    const next = vi.fn(() => throwError(() => httpError));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next))),
    ).rejects.toBe(refreshErr);

    expect(logout).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('on a guarded 401, when refresh succeeds it retries with the fresh token and does not redirect', async () => {
    const auth: Partial<AuthService> = {
      getToken: () => 'stale-access-token',
      refresh: () => of('fresh-access-token'),
      logout: () => of(undefined) as ReturnType<AuthService['logout']>,
    };
    configure(auth);

    const req = new HttpRequest('POST', GUARDED_API_URL, {});
    const httpError = new HttpErrorResponse({ status: 401, url: GUARDED_API_URL });
    const okResponse = new HttpResponse({ status: 200 });
    // First call (original) 401s; the retry after refresh succeeds.
    const next = vi
      .fn()
      .mockReturnValueOnce(throwError(() => httpError))
      .mockReturnValueOnce(of(okResponse));

    const result = await TestBed.runInInjectionContext(() =>
      lastValueFrom(authInterceptor(req, next)),
    );

    expect(result).toBe(okResponse);
    expect(next).toHaveBeenCalledTimes(2);
    expect(navigate).not.toHaveBeenCalled();
  });
});
