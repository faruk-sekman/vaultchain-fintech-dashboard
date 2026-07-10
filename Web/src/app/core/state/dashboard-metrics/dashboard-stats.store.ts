/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';

import { loadDashboardStats } from '@core/state/dashboard-metrics/dashboard-stats.actions';
import {
  selectDashboardKyc,
  selectDashboardStatsError,
  selectDashboardStatsLoading,
  selectDashboardSummary,
} from '@core/state/dashboard-metrics/dashboard-stats.selectors';

/**
 * Dashboard portfolio KPIs, sourced from the server-side aggregates (`/dashboard/summary` +
 * `/dashboard/kyc-distribution`) — page-size independent (retires the old client 60-cap).
 *
 * Lives in `@core/state` (not a single feature) because BOTH the dashboard and analytics lazy
 * routes consume it; each route registers the `dashboardStats` slice + effect via
 * `provideDashboardMetricsState()` (O-6). The `providedIn: 'root'` facade only reads/dispatches
 * through the global `Store`, so it injects everywhere while the reducer/effect stay route-scoped.
 */
@Injectable({ providedIn: 'root' })
export class DashboardStatsStore {
  private readonly store = inject(Store);

  readonly summary$ = this.store.select(selectDashboardSummary);
  readonly kyc$ = this.store.select(selectDashboardKyc);
  readonly loading$ = this.store.select(selectDashboardStatsLoading);
  readonly error$ = this.store.select(selectDashboardStatsError);

  load() {
    this.store.dispatch(loadDashboardStats());
  }
}
