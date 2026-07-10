/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Typed client for the operator MFA endpoints. Two call families:
 *
 *  - Login-flow (`verify` / `verifyBackupCode`): run mid-login when NO access token exists yet. They
 *    authenticate with the short-lived single-use httpOnly `ftd_mfa` challenge cookie the backend set
 *    on the `mfa_required` login response, so they MUST be sent with `withCredentials:true` (the FE
 *    never reads that cookie). On success the backend issues the real session (sets `ftd_refresh`,
 *    clears `ftd_mfa`) and returns the authenticated payload.
 *  - Bearer-flow (`setupStart` / `setupConfirm` / `disable` / `regenerateBackupCodes`): run from a
 *    full session; the auth interceptor attaches the in-memory access token. No cookie opt-in needed.
 *
 * Secret material (the otpauth secret, backup codes) is returned ONLY transiently for display and is
 * never logged, persisted, or echoed back on a read path.
 */
import { Injectable, inject } from '@angular/core';
import { HttpContext } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import type { AuthenticatedResponse } from '@core/auth/auth.model';

/** Send the httpOnly `ftd_mfa` challenge cookie on the two login-flow verify calls. */
const WITH_COOKIE = { withCredentials: true } as const;

/** Enrolment `start` payload: the otpauth provisioning data shown once during setup. */
export interface MfaSetupStartResponse {
  /** The `otpauth://totp/...` URI (manual-entry fallback + the QR source). */
  otpauthUri: string;
  /** A server-rendered QR image as a data-URL — bound directly to `<img [src]>` (no QR lib on the FE). */
  qrDataUrl: string;
}

/** Enrolment `confirm` + backup-code `regenerate` payload: the one-time backup codes. */
export interface MfaBackupCodesResponse {
  backupCodes: string[];
}

/**
 * One of the operator's active "remember this device" trust records. Mirrors the backend
 * `RememberedDeviceDto` exactly: no token/secret/UA-hash ever crosses the read path — only the id, the
 * lifecycle timestamps (ISO strings over the wire), and a COARSE network prefix bound at issue (a /24 or
 * /48, never a full IP). `createdAt`/`expiresAt` are strings here (JSON has no Date) and are rendered via
 * the `DatePipe` in the template.
 */
export interface RememberedDevice {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** Coarse network prefix bound at issue — NOT a full IP. */
  ipPrefix: string;
}

@Injectable({ providedIn: 'root' })
export class MfaApi {
  private readonly api = inject(ApiClientService);

  /**
   * Complete login with a 6-digit TOTP code (login-flow). `rememberDevice` is sent ONLY when the
   * operator opted in (default OFF) so the backend never mints a remembered-device record
   * implicitly. Uses the challenge cookie via `withCredentials`.
   */
  verify(code: string, rememberDevice = false): Observable<AuthenticatedResponse> {
    return this.api
      .post<{
        data: AuthenticatedResponse;
      }>('/auth/mfa/verify', { code, rememberDevice }, WITH_COOKIE)
      .pipe(map(res => res.data));
  }

  /** Complete login with a one-time backup code (login-flow recovery path). */
  verifyBackupCode(code: string): Observable<AuthenticatedResponse> {
    return this.api
      .post<{ data: AuthenticatedResponse }>('/auth/mfa/backup-code/verify', { code }, WITH_COOKIE)
      .pipe(map(res => res.data));
  }

  /**
   * Begin enrolment (Bearer-flow): re-authenticate with the account password and receive the otpauth
   * provisioning data (QR + manual key) to show in the wizard. No MFA is active until `setupConfirm`.
   */
  setupStart(password: string): Observable<MfaSetupStartResponse> {
    return this.api
      .post<{ data: MfaSetupStartResponse }>('/auth/mfa/setup/start', { password })
      .pipe(map(res => res.data));
  }

  /**
   * Confirm enrolment (Bearer-flow) by entering a current code from the authenticator; activates MFA
   * and returns the one-time backup codes to display exactly once.
   */
  setupConfirm(code: string): Observable<MfaBackupCodesResponse> {
    return this.api
      .post<{ data: MfaBackupCodesResponse }>('/auth/mfa/setup/confirm', { code })
      .pipe(map(res => res.data));
  }

  /**
   * Disable MFA (Bearer-flow). `code` is a 6-digit TOTP OR an `XXXXX-XXXXX` backup code; the password
   * re-auth is required by the backend. Resolves on the 204 with no body.
   */
  disable(password: string, code: string): Observable<void> {
    return this.api.post<void>('/auth/mfa/disable', { password, code }).pipe(map(() => undefined));
  }

  /**
   * Invalidate the prior backup-code set and issue a fresh one (Bearer-flow). Requires the password
   * re-auth + a current TOTP/backup code; returns the new codes to display once.
   */
  regenerateBackupCodes(password: string, code: string): Observable<MfaBackupCodesResponse> {
    return this.api
      .post<{ data: MfaBackupCodesResponse }>('/auth/mfa/backup-codes/regenerate', {
        password,
        code,
      })
      .pipe(map(res => res.data));
  }

  /**
   * List the operator's own active (non-revoked, non-expired) remembered devices (Bearer-flow). The
   * backend returns an empty list when the feature is OFF, so the UI degrades to its empty state — it
   * never assumes a device exists. `{ data }`-unwrapped like the other read paths.
   */
  listTrustedDevices(): Observable<RememberedDevice[]> {
    return this.api
      .get<{ data: RememberedDevice[] }>('/auth/mfa/devices')
      .pipe(map(res => res.data));
  }

  /**
   * Revoke ONE of the operator's own trusted devices (Bearer-flow); the next sign-in from it re-prompts
   * for MFA. Resolves void on the 204. The backend scopes the revoke to the caller and is idempotent, so
   * revoking an already-gone device still succeeds — the caller treats a 404 as already-revoked.
   */
  revokeTrustedDevice(id: string): Observable<void> {
    return this.api.delete<void>(`/auth/mfa/devices/${id}`).pipe(map(() => undefined));
  }

  /**
   * Administrator-only: reset a target operator's MFA (Bearer-flow), clearing their TOTP, backup codes,
   * and remembered devices server-side. The body is EXACTLY `{ userId }` — the
   * backend `AdminResetMfaDto` runs under the global whitelist/forbidNonWhitelisted pipe, so any extra
   * field (or `targetUserId`) is a 400. Resolves void on the 204; errors (403 self-reset, 404 unknown,
   * 400 invalid, 429 rate-limit) propagate to the caller, which maps them to a single inline message.
   *
   * Marked SILENT_REQUEST so `errorInterceptor` stays quiet: the admin-reset screen renders the failure
   * INLINE (one event → one message), so a global toast would be a duplicate. Bearer-flow — NO cookie
   * opt-in (the in-memory access token is attached by the auth interceptor).
   */
  adminReset(userId: string): Observable<void> {
    return this.api
      .post<void>(
        '/auth/mfa/admin-reset',
        { userId },
        { context: new HttpContext().set(SILENT_REQUEST, true) },
      )
      .pipe(map(() => undefined));
  }
}
