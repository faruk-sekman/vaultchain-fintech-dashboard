/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { provideState } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';

import {
  dashboardStatsFeatureKey,
  dashboardStatsReducer,
} from '@core/state/dashboard-metrics/dashboard-stats.reducer';
import { DashboardStatsEffects } from '@core/state/dashboard-metrics/dashboard-stats.effects';

/**
 * Route-level providers for the shared `dashboardStats` slice + its effect (O-6).
 *
 * The dashboard-stats aggregates are consumed by TWO separate lazy routes (dashboard and
 * analytics), so the slice is no longer registered eagerly at app bootstrap. Each route that
 * needs the KPIs calls this once in its `providers`; `provideState`/`provideEffects` register
 * lazily and idempotently (registering the same feature key twice is a no-op), so navigating
 * dashboard → analytics keeps the single `dashboardStats` slice and its already-loaded data.
 */
export function provideDashboardMetricsState(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideState(dashboardStatsFeatureKey, dashboardStatsReducer),
    provideEffects(DashboardStatsEffects),
  ]);
}
