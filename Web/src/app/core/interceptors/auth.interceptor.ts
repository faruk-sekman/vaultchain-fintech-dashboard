/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Attaches the Bearer access token to backend API requests. On a 401 from the API it transparently
 * rotates the access token via `AuthService.refresh()` and retries the original request ONCE;
 * only if refresh itself fails does it clear the session and redirect to /login.
 * Skips the login/refresh/logout endpoints (no token yet / would loop / public) and anything outside
 * the API base (e.g. Web3 RPC reads).
 *
 * `withCredentials` (the httpOnly refresh cookie) is set ONLY on the 3 `/auth/*`
 * calls by AuthService — never here. Normal protected API calls authenticate with the Bearer header
 * and must not send the cookie; the retried request below is likewise Bearer-only.
 */
import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { throwError } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { AuthService } from '@core/auth/auth.service';
import { environment } from '../../../environments/environment';

function withBearer(req: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const isApi = req.url.startsWith(environment.apiBaseUrl);
  // The two MFA verify endpoints run mid-login with NO access token — they authenticate
  // with the httpOnly `ftd_mfa` challenge cookie and surface their own inline errors, so they must
  // be treated like `/auth/login`: no Bearer, and a 401 (bad/expired code) must NOT trigger the
  // refresh-and-retry loop. The Bearer-flow MFA endpoints (setup/disable/regenerate) are NOT listed
  // here, so they still receive the token and can recover via refresh.
  // The self-service password-reset endpoints are likewise public + cookie-credentialed
  // (`ftd_pwreset`) and run with NO session: their 401s (invalid/expired/consumed challenge or bad
  // factor) are mapped INLINE by the reset wizard, so they must also bypass refresh-then-logout — a
  // refresh attempt for an anonymous visitor would 401 and wrongly redirect away from the wizard.
  const isAuthEntry =
    req.url.includes('/auth/login') ||
    req.url.includes('/auth/refresh') ||
    req.url.includes('/auth/logout') ||
    req.url.includes('/auth/mfa/verify') ||
    req.url.includes('/auth/mfa/backup-code/verify') ||
    req.url.includes('/auth/password/reset/');
  const token = auth.getToken();
  const guarded = isApi && !isAuthEntry;

  const outbound = token && guarded ? withBearer(req, token) : req;

  return next(outbound).pipe(
    catchError((err: HttpErrorResponse) => {
      // Only guarded API calls can recover via refresh. Login/refresh 401s (and non-API errors)
      // bubble straight up — refreshing the refresh call would loop.
      if (err.status !== 401 || !guarded) {
        return throwError(() => err);
      }

      // Rotate the access token once (single-flight in AuthService) and retry the original request
      // with the fresh token. If refresh itself fails, the session is already cleared — log out.
      return auth.refresh().pipe(
        switchMap((newToken: string) => next(withBearer(req, newToken))),
        catchError((refreshErr: unknown) => {
          auth.logout().subscribe();
          void router.navigate(['/login']);
          return throwError(() => refreshErr);
        }),
      );
    }),
  );
};
