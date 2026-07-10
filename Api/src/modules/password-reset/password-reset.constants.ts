/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset shared constants. Mirrors mfa.constants.ts. The reset
 * challenge `purpose` is a single closed value PASSWORD_RESET, kept as text + CHECK (not a native
 * enum) like `mfa_challenges.purpose` so the closed set can widen without a migration.
 * This flow is a SELF-CONTAINED, MFA-second-factor-gated password reset — there is NO email and NO
 * JWT; the only credential between initiate and verify is the httpOnly, SameSite=Strict `ftd_pwreset`
 * cookie scoped to /api/v1/auth.
 */

export const PasswordResetPurpose = {
  PasswordReset: 'PASSWORD_RESET',
} as const;

export type PasswordResetPurpose = (typeof PasswordResetPurpose)[keyof typeof PasswordResetPurpose];

/** The opaque reset-challenge token is `pwr_<id>.<secret>` — mirrors the MFA-challenge (`mfa_...`) format. */
export const PWRESET_CHALLENGE_TOKEN_PREFIX = 'pwr_';

/** Challenge-token lifetime (seconds) when `PWRESET_CHALLENGE_TTL` is unset — short-lived like the MFA challenge. */
export const PWRESET_CHALLENGE_TTL_DEFAULT = 300;

/** Max bad-factor attempts before a reset challenge fails closed — mirrors MFA_MAX_VERIFY_ATTEMPTS's default. */
export const PWRESET_MAX_ATTEMPTS_DEFAULT = 5;

/** Server-side new-password policy: min length (HARDER than the FE's 8 — reset mints a fresh credential). */
export const PWRESET_PASSWORD_MIN_LENGTH = 12;
/** New-password hard cap, mirroring Web/src/app/features/auth/password-policy.ts (PASSWORD_MAX). */
export const PWRESET_PASSWORD_MAX_LENGTH = 64;

/**
 * The second-factor method recorded on a verified reset challenge. Mirrors the in-code
 * shape-routing in PasswordResetService; stored as free text in `password_reset_challenges.factor_method`
 * (nullable, no native enum — consistent with `purpose`). A15 widens the union with
 * 'admin_approval': the challenge minted when the status endpoint claims an admin-APPROVED reset request
 * is pre-stamped with this method — the admin's identity check IS the second factor on that path.
 */
export type ResetMethod = 'totp' | 'backup_code' | 'admin_approval';

// ---------- A15/A16 — "request an admin reset" fallback (bugfix-backlog-2026-07) ----------
// The requesting BROWSER is bound to its `password_reset_requests` row by an opaque httpOnly cookie —
// an exact clone of the `ftd_pwreset` challenge-token pattern (`pwq_<id>.<secret>`, argon2id hash at
// rest). The cookie is the ONLY handle to the request; losing the browser = losing the handle
// (accepted v1 trade-off — wait for expiry and re-request, or use the direct admin reset).

/** Name of the httpOnly cookie that carries the opaque reset-request token. */
export const PWRESET_REQUEST_COOKIE_NAME = 'ftd_pwreq';

/** The opaque reset-request token is `pwq_<id>.<secret>` — mirrors the reset-challenge (`pwr_...`) format. */
export const PWRESET_REQUEST_TOKEN_PREFIX = 'pwq_';

/**
 * Reset-request lifetime (seconds) when `PWRESET_REQUEST_TTL` is unset — 24 h. ONE TTL covers both the
 * pending-decision and the approved-unclaimed windows; enforced LAZILY on read (no scheduler).
 */
export const PWRESET_REQUEST_TTL_DEFAULT = 86_400;

/**
 * Per-account create cooldown (seconds) when `PWRESET_REQUEST_COOLDOWN` is unset: a new request row is
 * silently skipped (same 202 + decoy cookie) while the account's newest row — ANY status — is younger.
 */
export const PWRESET_REQUEST_COOLDOWN_DEFAULT = 600;
