/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Auth contract types for the operator login flow, matching the backend
 * `/api/v1/auth/*` responses (envelope `{ data, meta }`). The refresh token is no longer in the
 * body — the backend sets it as an httpOnly cookie the browser stores and sends
 * automatically; the access token is what protected requests carry.
 */
export interface AuthUser {
  id: string;
  displayName: string | null;
  email: string; // already masked by the backend (e.g. o***@e***.com)
  /** Whether this operator has confirmed-enrolled an MFA second factor. */
  mfaEnabled: boolean;
  /**
   * ISO timestamp of the sign-in that issued this session (the backend stamps it at login, before
   * the session is built), or null before the first login. Optional so older fixtures/payloads
   * without the field stay valid — readers must treat absence as null. Drives the Settings
   * account-header "last sign-in" readout.
   */
  lastLoginAt?: string | null;
}

/**
 * A completed-authentication payload: the backend granted a session. Shared by the normal
 * password login and the MFA verify/backup-code completion — both end in the identical app state
 * (in-memory access token + principal). `status:'authenticated'` discriminates it from the pending
 * `mfa_required` branch below.
 */
export interface AuthenticatedResponse {
  status: 'authenticated';
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  permissions: string[];
  user: AuthUser;
}

/**
 * The password step succeeded but the operator has MFA enabled, so NO session is granted yet.
 * The backend has set the short-lived single-use httpOnly `ftd_mfa` challenge cookie; the
 * FE never reads it — it only surfaces the pending state and routes to `/mfa/verify`, which calls the
 * verify endpoint to complete login.
 */
export interface MfaRequiredResponse {
  status: 'mfa_required';
}

/**
 * Discriminated `POST /auth/login` result. The non-MFA path returns `authenticated`
 * exactly as before; an MFA-enrolled operator returns `mfa_required` (no token). The verify
 * endpoints (`/auth/mfa/verify`, `/auth/mfa/backup-code/verify`) always return `authenticated`.
 */
export type LoginResult = AuthenticatedResponse | MfaRequiredResponse;

/**
 * Response of `POST /auth/refresh`: a rotated access token. The backend also rotates the refresh
 * token (reuse detection is handled server-side) but re-sets it in the httpOnly cookie, so the FE
 * only swaps in the new access token.
 */
export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface Principal {
  user: AuthUser;
  permissions: string[];
}
