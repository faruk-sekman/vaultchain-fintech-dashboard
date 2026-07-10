/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { CustomerStatusBadgeComponent } from '@features/customers/components/customer-status-badge/customer-status-badge.component';
import { kycLabelKey } from '@shared/utils/kyc-status';

describe('CustomerStatusBadgeComponent', () => {
  it('maps status to color', () => {
    const comp = new CustomerStatusBadgeComponent();
    comp.status = 'VERIFIED';
    expect(comp.color).toBe('green');
    comp.status = 'UNKNOWN';
    expect(comp.color).toBe('zinc');
  });

  it('exposes the shared i18n label key for the status', () => {
    const comp = new CustomerStatusBadgeComponent();
    comp.status = 'VERIFIED';
    expect(comp.labelKey).toBe(kycLabelKey('VERIFIED'));
  });
});
