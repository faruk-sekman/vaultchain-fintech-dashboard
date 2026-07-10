/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, expect, it } from 'vitest';

import {
  TX_KIND_FILTER_OPTIONS,
  TX_KIND_ORDER,
  TX_STATUS_FILTER_OPTIONS,
  TX_STATUS_ORDER,
  getTxKindBadgeColor,
  getTxStatusBadgeColor,
  txKindLabelKey,
  txStatusLabelKey,
} from './transaction-status';

describe('transaction-status helpers', () => {
  it('maps known transaction kinds and statuses to semantic badge colours', () => {
    expect(getTxKindBadgeColor('DEPOSIT')).toBe('green');
    expect(getTxKindBadgeColor('WITHDRAWAL')).toBe('blue');
    expect(getTxStatusBadgeColor('POSTED')).toBe('green');
    expect(getTxStatusBadgeColor('FAILED')).toBe('red');
  });

  it('falls back to gray for unknown backend values', () => {
    expect(getTxKindBadgeColor('NEW_KIND')).toBe('gray');
    expect(getTxStatusBadgeColor('NEW_STATUS')).toBe('gray');
  });

  it('builds stable translation keys and filter options with a leading all-option', () => {
    expect(txKindLabelKey('REVERSAL')).toBe('transactions.kinds.REVERSAL');
    expect(txStatusLabelKey('PENDING')).toBe('transactions.statuses.PENDING');
    expect(TX_KIND_FILTER_OPTIONS[0]).toEqual({ labelKey: 'common.all', value: '' });
    expect(TX_STATUS_FILTER_OPTIONS[0]).toEqual({ labelKey: 'common.all', value: '' });
    expect(TX_KIND_FILTER_OPTIONS.slice(1).map(option => option.value)).toEqual(TX_KIND_ORDER);
    expect(TX_STATUS_FILTER_OPTIONS.slice(1).map(option => option.value)).toEqual(TX_STATUS_ORDER);
  });
});
