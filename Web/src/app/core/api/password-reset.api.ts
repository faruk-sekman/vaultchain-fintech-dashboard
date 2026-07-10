/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Typed client for the self-service password-reset endpoints (split into a
 * verify-code + verify pair). A SELF-CONTAINED, MFA-gated "forgot password" flow — NO
 * emailed link, NO JWT. Three @Public POSTs:
 *
 *   initiate(email)        → POST /auth/password/reset/initiate. ALWAYS 202 { status: 'reset_initiated' }
 *     (no user enumeration). The backend sets the short-lived httpOnly `ftd_pwreset` challenge cookie
 *     ONLY for an eligible MFA-enrolled account; the FE never reads it and ALWAYS advances. Must be sent
 *     with `withCredentials:true` so the browser stores that Set-Cookie.
 *   verifyCode(code)       → POST /auth/password/reset/verify-code. Verifies the second factor (6-digit
 *     TOTP or backup code) ONCE; the backend stamps `factor_verified_at` on the challenge. 200
 *     { status: 'code_verified' }. The `ftd_pwreset` cookie is the only credential (withCredentials:true).
 *   verify(newPassword)    → POST /auth/password/reset/verify. Sets the new password ONLY (the factor was
 *     already proven at verify-code; a missing stamp yields 401 Auth.ResetFactorRequired). 200
 *     { status: 'reset_complete' } with NO tokens (the operator must sign in fresh at /login).
 *
 * All calls are marked SILENT_REQUEST: their failures are rendered INLINE by the reset wizard (per-step
 * error region), so `errorInterceptor` must stay quiet and not raise a duplicate global toast — exactly
 * like `AuthService.login` does. The verify code + the new password are never logged.
 */
import { Injectable, inject } from '@angular/core';
import { HttpContext } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';

/** Route constants for the three @Public reset endpoints (relative to the `/api/v1` base). */
export const PASSWORD_RESET_INITIATE_PATH = '/auth/password/reset/initiate';
export const PASSWORD_RESET_VERIFY_CODE_PATH = '/auth/password/reset/verify-code';
export const PASSWORD_RESET_VERIFY_PATH = '/auth/password/reset/verify';

/**
 * Administrator-only reset path (separate from the self-service flow above). Bearer-flow,
 * NOT @Public: the backend gates it on `auth.password.admin_reset` and is the real authority.
 */
export const PASSWORD_ADMIN_RESET_PATH = '/auth/password/admin-reset';

/**
 * Admin-approval fallback (A15/A16): the @Public create + status/claim pair for operators who cannot
 * complete the MFA step. The requesting BROWSER is bound to its request by the opaque httpOnly
 * `ftd_pwreq` cookie (set on EVERY create response — real or decoy — so nothing about account existence
 * or an already-pending request leaks). Status is a POST because claiming an approval is a side effect;
 * the SameSite=Strict cookie is the CSRF control.
 */
export const PASSWORD_RESET_REQUEST_PATH = '/auth/password/reset-request';
export const PASSWORD_RESET_REQUEST_STATUS_PATH = '/auth/password/reset-request/status';

/**
 * Administrator review surface for the A15 requests (list/detail/approve/deny). Bearer-flow, NOT
 * @Public: the backend gates every route on `auth.password.admin_reset`.
 */
export const PASSWORD_RESET_REQUESTS_ADMIN_PATH = '/auth/password/reset-requests';

/**
 * Send/receive the httpOnly `ftd_pwreset` challenge cookie and suppress the global error toast (the
 * wizard surfaces failures inline). Mirrors the `WITH_COOKIE` + SILENT_REQUEST shape in
 * `AuthService.login`. A fresh `HttpContext` per call keeps the token scoped to that request.
 */
function withCookieSilent(): {
  withCredentials: true;
  context: HttpContext;
} {
  return { withCredentials: true, context: new HttpContext().set(SILENT_REQUEST, true) };
}

/** 202 acknowledgement — constant for every email so the caller cannot infer account existence. */
export interface ResetInitiatedResponse {
  status: 'reset_initiated';
}

/** 200 result of verify-code — the second factor was verified and the challenge stamped. */
export interface CodeVerifiedResponse {
  status: 'code_verified';
}

/** 200 result — the password was changed and all sessions revoked; NO tokens are issued. */
export interface ResetCompleteResponse {
  status: 'reset_complete';
}

/** 202 acknowledgement of a reset request — ONE constant body for every caller (no enumeration). */
export interface ResetRequestReceivedResponse {
  status: 'reset_request_received';
}

/**
 * Poll result of the status/claim endpoint. `pending` is also the fail-closed answer for a
 * missing/decoy/unknown cookie (indistinguishable by design); `approved` means the response has ALREADY
 * set the `ftd_pwreset` challenge cookie, so the wizard can jump straight to the set-password step.
 */
export type ResetRequestPollStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ResetRequestStatusResponse {
  status: ResetRequestPollStatus;
}

/** Lifecycle of an admin-approval reset request (server enum order = PENDING-first list sort). */
export type ResetRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/** PII-minimal requester identification — the email arrives ALREADY masked by the server. */
export interface ResetRequestAccount {
  displayName: string;
  /** Server-masked email (e.g. "a***@s***.local"); never the raw address — safe to render. */
  emailMasked: string;
}

/** One row of the admin list (`GET /auth/password/reset-requests`). */
export interface ResetRequestItem {
  id: string;
  account: ResetRequestAccount;
  status: ResetRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  /** Stamped when the granted set-password challenge was actually consumed (reset finished). */
  completedAt: string | null;
}

/**
 * Admin detail (`GET .../:id`) = the list row + honest request metadata: a coarse network prefix (the
 * full IP is NOT stored), a parsed device summary, and the raw user-agent for the collapsible view.
 */
export interface ResetRequestDetail extends ResetRequestItem {
  ipPrefix: string | null;
  deviceSummary: string;
  userAgent: string | null;
}

@Injectable({ providedIn: 'root' })
export class PasswordResetApi {
  private readonly api = inject(ApiClientService);

  /**
   * Start a self-service reset for `email`. Resolves with the constant `{ status: 'reset_initiated' }`
   * for every input (no enumeration). The eligibility-gated `ftd_pwreset` cookie is set transparently
   * by the browser when present; the caller advances to the verify-code step either way.
   */
  initiate(email: string): Observable<ResetInitiatedResponse> {
    return this.api
      .post<{
        data: ResetInitiatedResponse;
      }>(PASSWORD_RESET_INITIATE_PATH, { email }, withCookieSilent())
      .pipe(map(res => res.data));
  }

  /**
   * Verify the second factor (6-digit TOTP or backup code) ONCE. On success resolves
   * `{ status: 'code_verified' }` and the backend has stamped the challenge so the next /verify needs no
   * code. On failure the stable error `code` (`Auth.ResetInvalidCode`, `Auth.ResetChallenge*`) is mapped
   * to an inline message by the caller. The factor is single-use server-side — do NOT resend a code that
   * already succeeded for this challenge (the backend short-circuits an already-stamped challenge).
   */
  verifyCode(code: string): Observable<CodeVerifiedResponse> {
    return this.api
      .post<{
        data: CodeVerifiedResponse;
      }>(PASSWORD_RESET_VERIFY_CODE_PATH, { code }, withCookieSilent())
      .pipe(map(res => res.data));
  }

  /**
   * Set the new password (the factor was already proven at verify-code — there is NO code here). On
   * success resolves `{ status: 'reset_complete' }`; on failure the stable error `code` in the envelope
   * (`Auth.ResetFactorRequired`, `Auth.WeakPassword`, `Auth.SamePassword`, `Auth.ResetChallenge*`) is
   * mapped to an inline message by the caller.
   */
  verify(newPassword: string): Observable<ResetCompleteResponse> {
    return this.api
      .post<{
        data: ResetCompleteResponse;
      }>(PASSWORD_RESET_VERIFY_PATH, { newPassword }, withCookieSilent())
      .pipe(map(res => res.data));
  }

  /**
   * Administrator-only: set a TARGET operator's password. A Bearer-flow call — the
   * in-memory access token is attached by the auth interceptor, so there is NO cookie opt-in (unlike
   * the self-service trio above). The body is EXACTLY `{ targetUserId, newPassword }`; the backend
   * `AdminPasswordResetDto` runs under the global whitelist/forbidNonWhitelisted pipe, so any extra
   * field is a 400 and the FE selection is NOT trusted (the BE re-validates `targetUserId`).
   *
   * Server-side this revokes the target's sessions / remembered devices / open reset+MFA challenges
   * and clears the password lockout, in one audited transaction; the new password is never logged. It
   * does NOT disable the target's TOTP enrolment — that is admin MFA-reset, a different endpoint.
   *
   * Marked SILENT_REQUEST so `errorInterceptor` stays quiet: the admin password-reset screen renders
   * the failure INLINE (one event → one message), so a global toast would be a duplicate. Resolves on
   * the 204; errors (403 self-reset, 404 unknown, 400 weak/same, 429 rate-limit) propagate to the
   * caller, which maps each to a single inline message. The new password is never logged.
   */
  adminReset(targetUserId: string, newPassword: string): Observable<void> {
    return this.api
      .post<void>(
        PASSWORD_ADMIN_RESET_PATH,
        { targetUserId, newPassword },
        { context: new HttpContext().set(SILENT_REQUEST, true) },
      )
      .pipe(map(() => undefined));
  }

  // --- admin-approval fallback (A15/A16) ------------------------------------------------------

  /**
   * Ask the administrators to approve a password reset for `email`. ALWAYS resolves 202
   * `{ status: 'reset_request_received' }` — for unknown emails, duplicate requests, and cooldowns
   * alike — and the server ALWAYS sets an `ftd_pwreq` cookie (a decoy on the non-create branches), so
   * the response is byte-identical for everyone (no enumeration). `withCredentials` lets the browser
   * store that cookie; the FE never reads it.
   */
  createResetRequest(email: string): Observable<ResetRequestReceivedResponse> {
    return this.api
      .post<{
        data: ResetRequestReceivedResponse;
      }>(PASSWORD_RESET_REQUEST_PATH, { email }, withCookieSilent())
      .pipe(map(res => res.data));
  }

  /**
   * Poll the request bound to this browser's `ftd_pwreq` cookie. Never 401/404s — a missing/decoy/
   * unknown cookie reads as `pending` (fail-closed neutral). On `approved` the SAME response has set
   * the `ftd_pwreset` challenge cookie (factor pre-stamped `admin_approval`), so the caller advances
   * directly to the existing set-new-password step. POST with an empty body: the claim is a side
   * effect and the SameSite=Strict cookie is the CSRF control.
   */
  requestStatus(): Observable<ResetRequestStatusResponse> {
    return this.api
      .post<{
        data: ResetRequestStatusResponse;
      }>(PASSWORD_RESET_REQUEST_STATUS_PATH, {}, withCookieSilent())
      .pipe(map(res => res.data));
  }

  /**
   * Administrator-only: list reset requests (PENDING first — the server's enum order — then newest;
   * bounded server-side, no pagination v1). Optional `status` narrows to one lifecycle state. Bearer
   * flow (no cookie opt-in). NOTE: `ApiClientService.get` carries no HttpContext parameter, so unlike
   * the POSTs this read cannot be flagged SILENT_REQUEST — same trade-off as `RbacApi.listUsers`, and
   * the screen still renders its own inline load-error state.
   */
  listResetRequests(status?: ResetRequestStatus): Observable<ResetRequestItem[]> {
    return this.api
      .get<{
        data: ResetRequestItem[];
      }>(PASSWORD_RESET_REQUESTS_ADMIN_PATH, status ? { status } : undefined)
      .pipe(map(res => res.data));
  }

  /** Administrator-only: one request's detail incl. the honest device/network metadata. */
  getResetRequest(id: string): Observable<ResetRequestDetail> {
    return this.api
      .get<{
        data: ResetRequestDetail;
      }>(`${PASSWORD_RESET_REQUESTS_ADMIN_PATH}/${encodeURIComponent(id)}`)
      .pipe(map(res => res.data));
  }

  /**
   * Administrator-only: approve a PENDING request; resolves with the refreshed detail row. Errors ride
   * the stable-code envelope (`Auth.ResetRequestNotFound` / `Auth.ResetRequestAlreadyDecided` /
   * `Auth.ResetRequestExpired` / `Auth.SelfResetForbidden`) and are rendered INLINE by the screen —
   * hence SILENT_REQUEST (no duplicate global toast).
   */
  approveResetRequest(id: string): Observable<ResetRequestDetail> {
    return this.decide(id, 'approve');
  }

  /** Administrator-only: deny a PENDING request; identical contract to {@link approveResetRequest}. */
  denyResetRequest(id: string): Observable<ResetRequestDetail> {
    return this.decide(id, 'deny');
  }

  /** Shared approve/deny POST (empty body; the `:id` route segment carries the subject). */
  private decide(id: string, action: 'approve' | 'deny'): Observable<ResetRequestDetail> {
    return this.api
      .post<{
        data: ResetRequestDetail;
      }>(
        `${PASSWORD_RESET_REQUESTS_ADMIN_PATH}/${encodeURIComponent(id)}/${action}`,
        {},
        { context: new HttpContext().set(SILENT_REQUEST, true) },
      )
      .pipe(map(res => res.data));
  }
}
