/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Presentation helpers for the real backend transaction dimensions — `TransactionKind` /
 * `TransactionStatus` (Prisma enums). These are what the backend filters on, so the detail panel's
 * filter selects, columns and badges are driven from here (no derived/un-sendable dimensions).
 */
import { UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { SelectOption } from '@shared/components/ui-form/ui-form.types';
import { TransactionKind, TransactionStatus } from '@shared/models/transaction.model';

export const TX_KIND_ORDER: TransactionKind[] = [
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'FEE',
  'ADJUSTMENT',
  'REVERSAL',
];

export const TX_STATUS_ORDER: TransactionStatus[] = ['PENDING', 'POSTED', 'FAILED', 'REVERSED'];

export const TX_KIND_BADGE_COLORS: Record<TransactionKind, UiBadgeColor> = {
  DEPOSIT: 'green',
  WITHDRAWAL: 'blue',
  TRANSFER: 'indigo',
  FEE: 'yellow',
  ADJUSTMENT: 'purple',
  REVERSAL: 'fuchsia',
};

export const TX_STATUS_BADGE_COLORS: Record<TransactionStatus, UiBadgeColor> = {
  PENDING: 'yellow',
  POSTED: 'green',
  FAILED: 'red',
  REVERSED: 'gray',
};

export const getTxKindBadgeColor = (kind: TransactionKind | string): UiBadgeColor =>
  TX_KIND_BADGE_COLORS[kind as TransactionKind] ?? 'gray';

export const getTxStatusBadgeColor = (status: TransactionStatus | string): UiBadgeColor =>
  TX_STATUS_BADGE_COLORS[status as TransactionStatus] ?? 'gray';

export const txKindLabelKey = (kind: TransactionKind | string): string =>
  `transactions.kinds.${kind}`;
export const txStatusLabelKey = (status: TransactionStatus | string): string =>
  `transactions.statuses.${status}`;

const withAll = (options: SelectOption[]): SelectOption[] => [
  { labelKey: 'common.all', value: '' },
  ...options,
];

export const TX_KIND_FILTER_OPTIONS: SelectOption[] = withAll(
  TX_KIND_ORDER.map(kind => ({ labelKey: txKindLabelKey(kind), value: kind })),
);

export const TX_STATUS_FILTER_OPTIONS: SelectOption[] = withAll(
  TX_STATUS_ORDER.map(status => ({ labelKey: txStatusLabelKey(status), value: status })),
);
