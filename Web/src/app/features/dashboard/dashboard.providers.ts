/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { provideState } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';

import { provideDashboardMetricsState } from '@core/state/dashboard-metrics';
import {
  latestCustomerFeatureKey,
  latestCustomerReducer,
} from '@features/dashboard/state/latest-customer.reducer';
import { LatestCustomerEffects } from '@features/dashboard/state/latest-customer.effects';

/**
 * Route-level NgRx providers for the dashboard screen (O-6): the shared `dashboardStats` slice
 * (also used by analytics) plus the dashboard-only `latestCustomer` slice. Registered on the
 * dashboard lazy route so neither slice instantiates at app bootstrap.
 */
export function provideDashboardState(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideDashboardMetricsState(),
    provideState(latestCustomerFeatureKey, latestCustomerReducer),
    provideEffects(LatestCustomerEffects),
  ]);
}
