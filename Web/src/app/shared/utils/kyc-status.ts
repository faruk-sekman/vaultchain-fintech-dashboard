/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Single source of truth for the KYC status presentation — the real backend 6-value enum
 * (`KycStatus`). Used by the customer list/detail/form and the dashboard so labels, colours and
 * filter options stay in lockstep with what the backend stores and filters on.
 */
import { UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { SelectOption } from '@shared/components/ui-form/ui-form.types';
import { KycStatus } from '@shared/models/customer.model';

export const KYC_STATUS_ORDER: KycStatus[] = [
  'NOT_STARTED',
  'PENDING',
  'IN_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
];

export const KYC_STATUS_BADGE_COLORS: Record<KycStatus, UiBadgeColor> = {
  NOT_STARTED: 'zinc',
  PENDING: 'yellow',
  IN_REVIEW: 'blue',
  VERIFIED: 'green',
  REJECTED: 'red',
  EXPIRED: 'gray',
};

export const getKycStatusBadgeColor = (status: KycStatus | string): UiBadgeColor => {
  return KYC_STATUS_BADGE_COLORS[status as KycStatus] ?? 'zinc';
};

/** i18n key for a KYC status (shared `kyc.*` namespace). */
export const kycLabelKey = (status: KycStatus | string): string => `kyc.${status}`;

export const KYC_STATUS_OPTIONS: SelectOption[] = KYC_STATUS_ORDER.map(status => ({
  labelKey: kycLabelKey(status),
  value: status,
}));

export const KYC_STATUS_FILTER_OPTIONS: SelectOption[] = [
  { labelKey: 'common.all', value: '' },
  ...KYC_STATUS_OPTIONS,
];
