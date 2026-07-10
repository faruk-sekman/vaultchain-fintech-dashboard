/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createReducer, on } from '@ngrx/store';
import { DashboardSummary, KycDistribution } from '@core/api/dashboard.api';
import {
  loadDashboardStats,
  loadDashboardStatsFailure,
  loadDashboardStatsSuccess,
} from '@core/state/dashboard-metrics/dashboard-stats.actions';

export const dashboardStatsFeatureKey = 'dashboardStats';

export interface DashboardStatsState {
  summary: DashboardSummary | null;
  kyc: KycDistribution | null;
  loading: boolean;
  error: unknown | null;
}

export const initialState: DashboardStatsState = {
  summary: null,
  kyc: null,
  loading: false,
  error: null,
};

export const dashboardStatsReducer = createReducer(
  initialState,
  on(loadDashboardStats, state => ({ ...state, loading: true, error: null })),
  on(loadDashboardStatsSuccess, (state, { summary, kyc }) => ({
    ...state,
    summary,
    kyc,
    loading: false,
    error: null,
  })),
  on(loadDashboardStatsFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
);
