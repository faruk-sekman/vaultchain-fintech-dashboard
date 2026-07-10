/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA shared constants. The challenge `purpose` values mirror the `mfa_challenges.purpose`
 * CHECK set (text + CHECK, not a native enum — the closed set can widen without a
 * migration). LOGIN gates an interactive sign-in; ENROLL confirms a freshly created TOTP enrollment.
 */

export const MfaPurpose = {
  Login: 'LOGIN',
  Enroll: 'ENROLL',
} as const;

export type MfaPurpose = (typeof MfaPurpose)[keyof typeof MfaPurpose];

/** The opaque challenge token is `mfa_<id>.<secret>` — mirrors the refresh-token (`rt_…`) format. */
export const MFA_CHALLENGE_TOKEN_PREFIX = 'mfa_';
