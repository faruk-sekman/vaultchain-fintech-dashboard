/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import {
  getKycStatusBadgeColor,
  KYC_STATUS_FILTER_OPTIONS,
  KYC_STATUS_OPTIONS,
  KYC_STATUS_ORDER,
} from '@shared/utils/kyc-status';

describe('kyc-status utils', () => {
  it('maps the real 6-value KYC enum to badge colors', () => {
    expect(getKycStatusBadgeColor('NOT_STARTED')).toBe('zinc');
    expect(getKycStatusBadgeColor('PENDING')).toBe('yellow');
    expect(getKycStatusBadgeColor('IN_REVIEW')).toBe('blue');
    expect(getKycStatusBadgeColor('VERIFIED')).toBe('green');
    expect(getKycStatusBadgeColor('REJECTED')).toBe('red');
    expect(getKycStatusBadgeColor('EXPIRED')).toBe('gray');
  });

  it('falls back to zinc for unknown status', () => {
    expect(getKycStatusBadgeColor('OTHER')).toBe('zinc');
  });

  it('builds filter options with all option first', () => {
    expect(KYC_STATUS_OPTIONS.map(o => o.value)).toEqual(KYC_STATUS_ORDER);
    expect(KYC_STATUS_FILTER_OPTIONS[0].value).toBe('');
    expect(KYC_STATUS_FILTER_OPTIONS.length).toBe(KYC_STATUS_ORDER.length + 1);
  });
});
