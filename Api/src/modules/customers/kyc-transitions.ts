/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * KYC lifecycle transition matrix (re-audit DATA-001, operator-approved 2026-07-01). A manual
 * compliance operator may verify DIRECTLY from a positive/neutral state (NOT_STARTED / PENDING /
 * IN_REVIEW) — e.g. an in-person or trusted-channel KYC — but a NEGATIVE decision (REJECTED / EXPIRED)
 * must go back through re-review (→ IN_REVIEW) before it can become VERIFIED again, and a VERIFIED
 * customer can never be downgraded to NOT_STARTED / PENDING. Same→same is a no-op (never validated).
 */
import { KycStatus } from '@prisma/client';

/** For each current status, the set of legal next statuses (excluding itself). */
const ALLOWED: Record<KycStatus, ReadonlySet<KycStatus>> = {
  [KycStatus.NOT_STARTED]: new Set([KycStatus.PENDING, KycStatus.IN_REVIEW, KycStatus.VERIFIED, KycStatus.REJECTED]),
  [KycStatus.PENDING]: new Set([KycStatus.NOT_STARTED, KycStatus.IN_REVIEW, KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.EXPIRED]),
  [KycStatus.IN_REVIEW]: new Set([KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.EXPIRED]),
  // No downgrade to NOT_STARTED / PENDING once verified.
  [KycStatus.VERIFIED]: new Set([KycStatus.IN_REVIEW, KycStatus.REJECTED, KycStatus.EXPIRED]),
  // A negative decision must be re-reviewed before it can be VERIFIED/EXPIRED again.
  [KycStatus.REJECTED]: new Set([KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.IN_REVIEW]),
  [KycStatus.EXPIRED]: new Set([KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.IN_REVIEW]),
};

/** True when `to` is a legal next KYC status from `from` (an unchanged status is always allowed). */
export function isKycTransitionAllowed(from: KycStatus, to: KycStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].has(to);
}
