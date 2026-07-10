/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Guards the dashboard route's NgRx wiring, not just DI construction: the facades are
 * providedIn:'root', so instanceof checks pass even with provideState/provideEffects deleted.
 * Assert the real contract — BOTH slices (`dashboardStats` shared + `latestCustomer`
 * dashboard-only) register with their initial state, and a dispatched load reaches the
 * (stubbed) DashboardApi via the registered latest-customer effect.
 */

import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngrx/store';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { DashboardApi } from '@core/api/dashboard.api';
import {
  dashboardStatsFeatureKey,
  initialState as dashboardStatsInitialState,
} from '@core/state/dashboard-metrics/dashboard-stats.reducer';
import { loadLatestCustomer } from './state/latest-customer.actions';
import {
  latestCustomerFeatureKey,
  initialState as latestCustomerInitialState,
} from './state/latest-customer.reducer';
import { provideDashboardState } from './dashboard.providers';

describe('provideDashboardState', () => {
  function setup() {
    const dashboardApi = {
      getSummary: vi.fn(() => of({ totalCustomers: 1 })),
      getKycDistribution: vi.fn(() => of({ total: 1 })),
      getLatestCustomer: vi.fn(() => of(null)),
      getRecentCustomers: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore(),
        provideDashboardState(),
        { provide: DashboardApi, useValue: dashboardApi },
      ],
    });
    return { store: TestBed.inject(Store), dashboardApi };
  }

  function snapshot(store: Store): Record<string, unknown> {
    let state: Record<string, unknown> = {};
    store.subscribe(s => (state = s as Record<string, unknown>)).unsubscribe();
    return state;
  }

  it('registers the shared dashboardStats AND dashboard-only latestCustomer slices with initial state', () => {
    const { store } = setup();
    const state = snapshot(store);

    expect(state[dashboardStatsFeatureKey]).toEqual(dashboardStatsInitialState);
    expect(state[latestCustomerFeatureKey]).toEqual(latestCustomerInitialState);
  });

  it('registers the latest-customer effect: dispatching load reaches the API and reduces the result', () => {
    const { store, dashboardApi } = setup();

    store.dispatch(loadLatestCustomer());

    expect(dashboardApi.getLatestCustomer).toHaveBeenCalledTimes(1);
    const slice = snapshot(store)[latestCustomerFeatureKey] as typeof latestCustomerInitialState;
    expect(slice.loaded).toBe(true); // success (empty) round-trip through the registered reducer
    expect(slice.loading).toBe(false);
  });
});
