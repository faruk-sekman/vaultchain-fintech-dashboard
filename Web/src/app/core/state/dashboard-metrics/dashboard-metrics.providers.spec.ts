/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Guards the route-level NgRx wiring for the shared `dashboardStats` slice, not just DI
 * construction: the facade is providedIn:'root', so an instanceof check passes even with
 * provideState/provideEffects deleted. Assert the real contract instead — the slice registers
 * with its initial state and a dispatched load reaches the (stubbed) DashboardApi via the
 * registered effect, landing back in the slice through the registered reducer.
 */

import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngrx/store';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { DashboardApi } from '@core/api/dashboard.api';
import { loadDashboardStats } from './dashboard-stats.actions';
import { dashboardStatsFeatureKey, initialState } from './dashboard-stats.reducer';
import { provideDashboardMetricsState } from './dashboard-metrics.providers';

const summary = { totalCustomers: 65 } as never;
const kyc = { total: 65 } as never;

describe('provideDashboardMetricsState', () => {
  function setup() {
    const dashboardApi = {
      getSummary: vi.fn(() => of(summary)),
      getKycDistribution: vi.fn(() => of(kyc)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore(),
        provideDashboardMetricsState(),
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

  it('registers the dashboardStats slice with its initial state', () => {
    const { store } = setup();
    expect(snapshot(store)[dashboardStatsFeatureKey]).toEqual(initialState);
  });

  it('registers the effect: dispatching load reaches the API and reduces the success payload', () => {
    const { store, dashboardApi } = setup();

    store.dispatch(loadDashboardStats());

    expect(dashboardApi.getSummary).toHaveBeenCalledTimes(1);
    expect(dashboardApi.getKycDistribution).toHaveBeenCalledTimes(1);
    const slice = snapshot(store)[dashboardStatsFeatureKey] as typeof initialState;
    expect(slice.summary).toEqual(summary);
    expect(slice.kyc).toEqual(kyc);
    expect(slice.loading).toBe(false);
  });
});
