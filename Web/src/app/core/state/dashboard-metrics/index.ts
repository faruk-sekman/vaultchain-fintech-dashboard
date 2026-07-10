/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

// Neutral home for the shared dashboard-stats slice (O-6): consumed by both the dashboard and
// analytics lazy routes. Facade-only public surface — components consume the store, never the
// actions/selectors directly.
export { DashboardStatsStore } from '@core/state/dashboard-metrics/dashboard-stats.store';
export { provideDashboardMetricsState } from '@core/state/dashboard-metrics/dashboard-metrics.providers';
