/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the KYC transition matrix (re-audit DATA-001, operator-approved).
 */
import { KycStatus } from '@prisma/client';
import { isKycTransitionAllowed } from './kyc-transitions';

describe('isKycTransitionAllowed (DATA-001 KYC matrix)', () => {
  it('always allows an unchanged status (same → same)', () => {
    for (const s of Object.values(KycStatus)) {
      expect(isKycTransitionAllowed(s, s)).toBe(true);
    }
  });

  it('allows direct verification from a positive/neutral state', () => {
    expect(isKycTransitionAllowed(KycStatus.NOT_STARTED, KycStatus.VERIFIED)).toBe(true);
    expect(isKycTransitionAllowed(KycStatus.PENDING, KycStatus.VERIFIED)).toBe(true);
    expect(isKycTransitionAllowed(KycStatus.IN_REVIEW, KycStatus.VERIFIED)).toBe(true);
  });

  it('BLOCKS re-verifying a negative decision without re-review, but ALLOWS the re-review path', () => {
    expect(isKycTransitionAllowed(KycStatus.REJECTED, KycStatus.VERIFIED)).toBe(false);
    expect(isKycTransitionAllowed(KycStatus.EXPIRED, KycStatus.VERIFIED)).toBe(false);
    expect(isKycTransitionAllowed(KycStatus.REJECTED, KycStatus.IN_REVIEW)).toBe(true);
    expect(isKycTransitionAllowed(KycStatus.EXPIRED, KycStatus.IN_REVIEW)).toBe(true);
  });

  it('BLOCKS downgrading a VERIFIED customer to NOT_STARTED / PENDING', () => {
    expect(isKycTransitionAllowed(KycStatus.VERIFIED, KycStatus.NOT_STARTED)).toBe(false);
    expect(isKycTransitionAllowed(KycStatus.VERIFIED, KycStatus.PENDING)).toBe(false);
    expect(isKycTransitionAllowed(KycStatus.VERIFIED, KycStatus.EXPIRED)).toBe(true);
  });

  it('matches the full approved matrix for every from×to pair', () => {
    const matrix: Record<KycStatus, KycStatus[]> = {
      [KycStatus.NOT_STARTED]: [KycStatus.PENDING, KycStatus.IN_REVIEW, KycStatus.VERIFIED, KycStatus.REJECTED],
      [KycStatus.PENDING]: [KycStatus.NOT_STARTED, KycStatus.IN_REVIEW, KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.EXPIRED],
      [KycStatus.IN_REVIEW]: [KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.VERIFIED, KycStatus.REJECTED, KycStatus.EXPIRED],
      [KycStatus.VERIFIED]: [KycStatus.IN_REVIEW, KycStatus.REJECTED, KycStatus.EXPIRED],
      [KycStatus.REJECTED]: [KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.IN_REVIEW],
      [KycStatus.EXPIRED]: [KycStatus.NOT_STARTED, KycStatus.PENDING, KycStatus.IN_REVIEW],
    };
    const all = Object.values(KycStatus);
    for (const from of all) {
      for (const to of all) {
        const expected = from === to || matrix[from].includes(to);
        expect(isKycTransitionAllowed(from, to)).toBe(expected);
      }
    }
  });
});
