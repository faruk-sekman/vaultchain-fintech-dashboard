/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Operator authentication: login against the backend `/api/v1/auth/*` and hold the
 * access token + principal IN MEMORY only. The token is never written to web storage: on a full
 * reload it is re-obtained by a silent `/auth/refresh` at app bootstrap off the
 * httpOnly `ftd_refresh` cookie (see `provideAppInitializer` in `app.config.ts`). The Bearer header is
 * attached by the auth interceptor; the route guard reads `isAuthenticated`.
 *
 * Refresh token transport: the refresh token is no longer in JS — the backend sets
 * it as an httpOnly cookie (`ftd_refresh`) the browser stores and sends automatically on the 3
 * `/auth/*` calls (sent with `withCredentials:true`). XSS can no longer read it.
 *
 * Refresh rotation: the access token lives ~15 min, so the interceptor calls
 * `refresh()` on a 401 to rotate it transparently. `refresh()` is single-flight — concurrent 401s
 * share one in-flight call (`shareReplay`) so we never trigger a refresh storm. Token VALUES are
 * never logged.
 */
import { HttpContext } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, finalize, map, shareReplay, tap } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { ApiClientService } from '@core/api/api-client.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import {
  MfaApi,
  type MfaBackupCodesResponse,
  type MfaSetupStartResponse,
  type RememberedDevice,
} from '@core/api/mfa.api';
import { PasswordResetApi } from '@core/api/password-reset.api';
import type { AuthenticatedResponse, LoginResult, Principal, RefreshResponse } from './auth.model';

/** Send cookies (the httpOnly refresh cookie) only on the 3 `/auth/*` calls. */
const WITH_COOKIE = { withCredentials: true } as const;

/**
 * Non-sensitive "this browser has an active session" hint. It holds NO token — just the literal
 * `'1'` — so it does NOT reopen the XSS exposure that the in-memory token strategy closed. The
 * bootstrap silent refresh only probes `/auth/refresh` when this hint is present, so a
 * never-logged-in visitor never fires the probe and never sees a spurious 401 on the login screen.
 * Set on login; cleared on logout and on refresh failure (a stale hint self-heals after one probe).
 */
const SESSION_HINT_KEY = 'ftd_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiClientService);
  private readonly mfa = inject(MfaApi);
  private readonly passwordReset = inject(PasswordResetApi);

  /**
   * The access token lives in memory only — never web storage, so an XSS
   * payload cannot read it at rest. It starts `null` on every load; the bootstrap silent refresh
   * (`app.config.ts`) repopulates it from the httpOnly refresh cookie when a session exists.
   */
  private readonly accessToken = signal<string | null>(null);
  private readonly _principal = signal<Principal | null>(null);

  /**
   * Mid-login MFA gate: set true when `login()` returns `mfa_required` — the password step
   * passed but NO session is granted yet (no access token), so `isAuthenticated()` stays false. The
   * `/mfa/verify` route guard reads this to allow the verify screen; it is cleared on a successful
   * verify (which sets the token) or on logout. Never holds any secret — just the pending flag.
   */
  private readonly _mfaPending = signal(false);

  /** Shared in-flight refresh so concurrent 401s collapse to a single `/auth/refresh` call. */
  private inFlightRefresh: Observable<string> | null = null;
  /** Shared in-flight principal load so concurrent rehydrate callers collapse to one `/auth/me`. */
  private inFlightPrincipal: Observable<Principal> | null = null;

  readonly isAuthenticated = computed(() => this.accessToken() !== null);
  readonly principal = this._principal.asReadonly();
  /** Whether a `mfa_required` login is awaiting its second factor (drives the `/mfa/verify` guard). */
  readonly mfaPending = this._mfaPending.asReadonly();
  /** Whether the current operator has MFA enabled (from the principal; false until it loads). */
  readonly mfaEnabled = computed(() => this._principal()?.user.mfaEnabled ?? false);

  /**
   * The permission codes the backend granted the current operator (empty until the principal loads).
   * Derived as a `computed` so any reactive consumer (and OnPush templates calling `hasPermission`)
   * re-evaluates when the principal is set/cleared/rehydrated (login, `/auth/me`, logout).
   */
  private readonly permissions = computed<readonly string[]>(
    () => this._principal()?.permissions ?? [],
  );

  /**
   * Defense-in-depth UI gate: does the loaded operator hold `permission`?
   * The backend remains the real authority (it returns 403); this only decides whether to
   * show/enable an action so an under-privileged operator isn't offered controls that would 403.
   * Fails closed: returns `false` when the principal hasn't loaded yet (pre-login / mid-reload),
   * so nothing privileged renders before we actually know the operator's permissions.
   */
  hasPermission(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  /**
   * Authenticate the operator. The backend returns a discriminated result: a non-MFA
   * operator gets `authenticated` (session granted exactly as before); an MFA-enrolled operator gets
   * `mfa_required` — NO token is set, instead `mfaPending` flips true so the caller routes to
   * `/mfa/verify`. Token VALUES are never logged.
   */
  login(email: string, password: string): Observable<LoginResult> {
    // Login failures are surfaced INLINE by LoginComponent (the ui-alert banner), so mark the request
    // SILENT_REQUEST: errorInterceptor then skips the duplicate GLOBAL toast (one event → one message).
    const opts = { ...WITH_COOKIE, context: new HttpContext().set(SILENT_REQUEST, true) };
    return this.api.post<{ data: LoginResult }>('/auth/login', { email, password }, opts).pipe(
      map(res => res.data),
      tap(data => {
        if (data.status === 'mfa_required') {
          // Password OK but a second factor is required: hold the pending state, grant NO session.
          this._mfaPending.set(true);
          return;
        }
        // Fail-closed: `completeAuthentication` is the ONLY token-issuing path and itself rejects any
        // non-`authenticated`/tokenless payload (e.g. a malformed `{}`), so no half-auth state leaks.
        this.completeAuthentication(data);
      }),
    );
  }

  /**
   * Complete login with a 6-digit TOTP code. The challenge rides the httpOnly `ftd_mfa`
   * cookie (sent by `MfaApi` via `withCredentials`); on success the backend issues the real session
   * and we set the in-memory token + principal exactly like a normal login. `rememberDevice` defaults
   * OFF and is forwarded by the caller only when the operator opts in.
   */
  mfaVerify(code: string, rememberDevice: boolean): Observable<AuthenticatedResponse> {
    return this.mfa
      .verify(code, rememberDevice)
      .pipe(tap(data => this.completeAuthentication(data)));
  }

  /** Complete login with a one-time backup code (recovery path). */
  mfaVerifyBackupCode(code: string): Observable<AuthenticatedResponse> {
    return this.mfa.verifyBackupCode(code).pipe(tap(data => this.completeAuthentication(data)));
  }

  /** Begin MFA enrolment (Bearer-flow): re-auth with the password, get the otpauth QR + manual key. */
  mfaSetupStart(password: string): Observable<MfaSetupStartResponse> {
    return this.mfa.setupStart(password);
  }

  /** Confirm enrolment with a current code; activates MFA and returns the one-time backup codes. */
  mfaSetupConfirm(code: string): Observable<MfaBackupCodesResponse> {
    // Refresh the principal so `mfaEnabled` flips true after activation (drives the Settings card).
    return this.mfa.setupConfirm(code).pipe(tap(() => this.refreshPrincipalQuietly()));
  }

  /** Disable MFA (Bearer-flow); refreshes the principal so the Settings card reflects the change. */
  mfaDisable(password: string, code: string): Observable<void> {
    return this.mfa.disable(password, code).pipe(tap(() => this.refreshPrincipalQuietly()));
  }

  /** Invalidate the prior backup-code set and issue a fresh one (Bearer-flow). */
  mfaRegenerateBackupCodes(password: string, code: string): Observable<MfaBackupCodesResponse> {
    return this.mfa.regenerateBackupCodes(password, code);
  }

  /** List the operator's own active remembered ("trusted") devices (Bearer-flow); empty when off. */
  mfaListDevices(): Observable<RememberedDevice[]> {
    return this.mfa.listTrustedDevices();
  }

  /** Revoke one of the operator's own trusted devices (Bearer-flow); resolves void on the 204. */
  mfaRevokeDevice(id: string): Observable<void> {
    return this.mfa.revokeTrustedDevice(id);
  }

  /**
   * Administrator-only: reset a TARGET operator's MFA (Bearer-flow). A thin passthrough to
   * `MfaApi.adminReset` — this touches another user, never the current session/principal, so it
   * mutates no local auth state. The backend `auth.mfa.admin_reset` permission is the real authority
   * (and returns 403 for self-reset); the FE route/UI gate is defense-in-depth.
   */
  mfaAdminReset(userId: string): Observable<void> {
    return this.mfa.adminReset(userId);
  }

  /**
   * Administrator-only: set a TARGET operator's password. A thin passthrough to
   * `PasswordResetApi.adminReset` — it touches another user, never the current session/principal, so it
   * mutates no local auth state. The backend `auth.password.admin_reset` permission is the real
   * authority (and returns 403 for self-reset); the FE route/UI gate is defense-in-depth. The new
   * password is never logged.
   */
  adminResetPassword(targetUserId: string, newPassword: string): Observable<void> {
    return this.passwordReset.adminReset(targetUserId, newPassword);
  }

  /**
   * Abandon an in-progress MFA challenge: clear the `mfaPending` gate so `/mfa/verify` is
   * no longer admissible until a fresh password step re-establishes it. Called when the operator
   * chooses "back to login" from the verify screen. The backend `ftd_mfa` cookie is httpOnly and
   * expires/clears server-side; the FE only drops its own pending flag.
   */
  cancelMfaPending(): void {
    this._mfaPending.set(false);
  }

  /**
   * Shared completion path for both the normal login and the MFA verify: set the in-memory
   * access token + principal and the non-sensitive session hint, and clear any pending-MFA state. The
   * end-state is identical regardless of which factor path got here.
   *
   * Fail-closed: only a well-formed `authenticated` payload that actually carries an access token may
   * mint a session — a malformed/empty response (e.g. `status` missing, no token) is rejected so no
   * half-authenticated `isAuthenticated()===true` with an `undefined` token can ever occur.
   */
  private completeAuthentication(data: AuthenticatedResponse): void {
    if (data?.status !== 'authenticated' || !data.accessToken) {
      throw new Error('Unexpected authentication response');
    }
    this.accessToken.set(data.accessToken);
    this._principal.set({ user: data.user, permissions: data.permissions });
    this._mfaPending.set(false);
    writeSessionHint(true);
  }

  /** Best-effort principal refresh after an enable/disable so `mfaEnabled` re-reads `/auth/me`. */
  private refreshPrincipalQuietly(): void {
    this.loadPrincipal().subscribe({ error: () => undefined });
  }

  /**
   * Rotate the access token. The refresh token rides in the httpOnly `ftd_refresh` cookie the
   * browser sends automatically (`withCredentials:true`), so there is no token to read in JS — the
   * backend reads the cookie, rotates it, and re-sets it. Single-flight: the first caller starts the
   * request and every concurrent caller subscribes to the same shared stream, which emits the new
   * access token. On any failure (missing/expired/reused cookie → 401) the session is cleared
   * (caller should redirect to /login).
   */
  refresh(silent = false): Observable<string> {
    if (this.inFlightRefresh) return this.inFlightRefresh;

    // The bootstrap probe (`app.config` initializer) passes `silent: true`: a 401/network failure
    // there just means "no session yet" and must not flash a global error toast on the login screen
    // (SILENT_REQUEST → errorInterceptor stays quiet). A mid-session refresh (interceptor-triggered)
    // is NOT silent, so genuine expiry still surfaces the `sessionExpired` notification.
    const opts = silent
      ? { ...WITH_COOKIE, context: new HttpContext().set(SILENT_REQUEST, true) }
      : WITH_COOKIE;

    this.inFlightRefresh = this.api.post<{ data: RefreshResponse }>('/auth/refresh', {}, opts).pipe(
      map(res => res.data),
      tap(data => {
        this.accessToken.set(data.accessToken);
      }),
      map(data => data.accessToken),
      catchError((err: unknown) => {
        // Refresh itself failed (no cookie / expired / reused / revoked) — drop the session so the
        // caller logs out.
        this.clearSession();
        return throwError(() => err);
      }),
      finalize(() => {
        this.inFlightRefresh = null;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    return this.inFlightRefresh;
  }

  /**
   * Refresh the principal from the server (used after a reload once the bootstrap silent refresh has
   * repopulated the token). Single-flight: on a guarded deep-link reload both
   * `permissionGuard` and `MainLayoutComponent.ngOnInit` ask for the principal before the first
   * `/auth/me` resolves, which previously fired the call twice. The first caller starts the request and
   * concurrent callers share the same in-flight stream; it clears on completion so a later rehydrate
   * still re-fetches. This is independent of the `refresh()` single-flight and does not touch the
   * reload-on-401 flow.
   */
  loadPrincipal(): Observable<Principal> {
    if (this.inFlightPrincipal) return this.inFlightPrincipal;

    this.inFlightPrincipal = this.api.get<{ data: Principal }>('/auth/me').pipe(
      map(res => res.data),
      tap(principal => this._principal.set(principal)),
      finalize(() => {
        this.inFlightPrincipal = null;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );

    return this.inFlightPrincipal;
  }

  /**
   * Sign the operator out. Clears the access token and principal from memory *synchronously* (the UI
   * is signed out immediately, regardless of network), then attempts to clear the refresh cookie
   * server-side via `POST /auth/logout` (sent with `withCredentials:true`). The revoke call is made
   * even when JS no longer has an access token: a stale httpOnly cookie may still exist after refresh
   * failure, and only the server can clear it. Token VALUES are never logged.
   */
  logout(): Observable<void> {
    this.clearSession();

    return this.api.post<void>('/auth/logout', {}, WITH_COOKIE).pipe(
      map(() => undefined),
      catchError(() => of(undefined)),
    );
  }

  getToken(): string | null {
    return this.accessToken();
  }

  /**
   * Drop the access token/principal from memory. The httpOnly refresh cookie is owned by the
   * browser and cleared server-side by `/auth/logout`.
   */
  /**
   * Whether this browser has an active-session hint — a prior login not yet logged out. The bootstrap
   * probe consults this so an anonymous first visit never calls `/auth/refresh` (no spurious 401).
   */
  hasSessionHint(): boolean {
    try {
      return localStorage.getItem(SESSION_HINT_KEY) === '1';
    } catch {
      return false;
    }
  }

  private clearSession(): void {
    this.accessToken.set(null);
    this._principal.set(null);
    this._mfaPending.set(false);
    writeSessionHint(false);
  }
}

/** Persist the non-sensitive session-presence hint (boolean only — never a token). */
function writeSessionHint(active: boolean): void {
  try {
    if (active) localStorage.setItem(SESSION_HINT_KEY, '1');
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Storage unavailable (SSR / privacy mode) — the bootstrap probe simply won't be skipped.
  }
}
