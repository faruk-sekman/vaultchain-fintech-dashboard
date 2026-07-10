/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

export * from '@features/dashboard/state/latest-customer.store';
export * from '@features/dashboard/state/latest-customer.actions';
export * from '@features/dashboard/state/latest-customer.reducer';
export * from '@features/dashboard/state/latest-customer.selectors';
// `DashboardStatsStore` now lives in `@core/state/dashboard-metrics` (O-6): it is shared by both
// the dashboard and analytics lazy routes, so it no longer belongs to a single feature barrel.
