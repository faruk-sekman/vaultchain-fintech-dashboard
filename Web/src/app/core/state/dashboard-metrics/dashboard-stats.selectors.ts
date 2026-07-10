/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  DashboardStatsState,
  dashboardStatsFeatureKey,
} from '@core/state/dashboard-metrics/dashboard-stats.reducer';

export const selectDashboardStatsState =
  createFeatureSelector<DashboardStatsState>(dashboardStatsFeatureKey);

export const selectDashboardSummary = createSelector(
  selectDashboardStatsState,
  state => state.summary,
);

export const selectDashboardKyc = createSelector(selectDashboardStatsState, state => state.kyc);

export const selectDashboardStatsLoading = createSelector(
  selectDashboardStatsState,
  state => state.loading,
);

export const selectDashboardStatsError = createSelector(
  selectDashboardStatsState,
  state => state.error,
);
