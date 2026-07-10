/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the dashboard-stats selectors (audit 9C Web). Exercises each projector against a
 * representative feature-state slice.
 */
import { describe, it, expect } from 'vitest';
import {
  selectDashboardSummary,
  selectDashboardKyc,
  selectDashboardStatsLoading,
  selectDashboardStatsError,
} from './dashboard-stats.selectors';

describe('dashboard-stats selectors', () => {
  const state = {
    summary: { totalCustomers: 5 },
    kyc: { items: [], total: 3, asOf: 'x' },
    loading: true,
    error: 'boom',
  } as never;

  it('selects the summary slice', () => {
    expect(selectDashboardSummary.projector(state)).toEqual({ totalCustomers: 5 });
  });

  it('selects the KYC slice', () => {
    expect(selectDashboardKyc.projector(state)).toMatchObject({ total: 3 });
  });

  it('selects the loading flag', () => {
    expect(selectDashboardStatsLoading.projector(state)).toBe(true);
  });

  it('selects the error', () => {
    expect(selectDashboardStatsError.projector(state)).toBe('boom');
  });
});
