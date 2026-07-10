/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { Subject, of, throwError } from 'rxjs';
import { DashboardStatsEffects } from '@core/state/dashboard-metrics/dashboard-stats.effects';
import { DashboardStatsStore } from '@core/state/dashboard-metrics/dashboard-stats.store';
import {
  loadDashboardStats,
  loadDashboardStatsFailure,
  loadDashboardStatsSuccess,
} from '@core/state/dashboard-metrics/dashboard-stats.actions';
import {
  dashboardStatsFeatureKey,
  dashboardStatsReducer,
  initialState,
} from '@core/state/dashboard-metrics/dashboard-stats.reducer';
import {
  selectDashboardKyc,
  selectDashboardStatsLoading,
  selectDashboardSummary,
} from '@core/state/dashboard-metrics/dashboard-stats.selectors';
import { DashboardApi, DashboardSummary, KycDistribution } from '@core/api/dashboard.api';

const summary: DashboardSummary = {
  totalCustomers: 65,
  activeCount: 50,
  inactiveCount: 15,
  activeRate: 76.9,
  inactiveRate: 23.1,
  ageStats: { avg: 35, min: 30, max: 40 },
  asOf: '2026-06-07T00:00:00.000Z',
};
const kyc: KycDistribution = {
  items: [{ status: 'VERIFIED', count: 30, percent: 46.2 }],
  total: 65,
  asOf: '2026-06-07T00:00:00.000Z',
};

describe('DashboardStats state', () => {
  it('locks the feature key and the action type strings (NgRx registration/devtools contract)', () => {
    expect(dashboardStatsFeatureKey).toBe('dashboardStats');
    expect(loadDashboardStats.type).toBe('[Dashboard Stats] Load');
    expect(loadDashboardStatsSuccess.type).toBe('[Dashboard Stats] Load Success');
    expect(loadDashboardStatsFailure.type).toBe('[Dashboard Stats] Load Failure');
  });

  it('reducer honours the reducer contract (init, unknown action, failure→load error reset)', () => {
    expect(dashboardStatsReducer(undefined, { type: '@@init' })).toEqual(initialState);

    const state = { ...initialState, summary, kyc };
    expect(dashboardStatsReducer(state, { type: '[Nope] Unknown' })).toBe(state);

    const failed = dashboardStatsReducer(initialState, loadDashboardStatsFailure({ error: 'x' }));
    const retried = dashboardStatsReducer(failed, loadDashboardStats());
    expect(retried.error).toBeNull();
  });

  it('reducer handles load / success / failure', () => {
    const loading = dashboardStatsReducer(initialState, loadDashboardStats());
    expect(loading.loading).toBe(true);

    const loaded = dashboardStatsReducer(loading, loadDashboardStatsSuccess({ summary, kyc }));
    expect(loaded.summary).toEqual(summary);
    expect(loaded.kyc).toEqual(kyc);
    expect(loaded.loading).toBe(false);

    const failed = dashboardStatsReducer(loaded, loadDashboardStatsFailure({ error: 'x' }));
    expect(failed.error).toBe('x');
    expect(failed.loading).toBe(false);
  });

  it('selectors project state', () => {
    const state = { ...initialState, summary, kyc, loading: true };
    expect(selectDashboardSummary.projector(state)).toEqual(summary);
    expect(selectDashboardKyc.projector(state)).toEqual(kyc);
    expect(selectDashboardStatsLoading.projector(state)).toBe(true);
  });

  it('store dispatches load', () => {
    const storeMock = { select: vi.fn(() => of(null)), dispatch: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: storeMock }] });
    const store = TestBed.runInInjectionContext(() => new DashboardStatsStore());
    store.load();
    expect(storeMock.dispatch).toHaveBeenCalledWith(loadDashboardStats());
  });

  it('effects emit success from summary + kyc', () => {
    const actions$ = new Subject<unknown>();
    const api = { getSummary: vi.fn(() => of(summary)), getKycDistribution: vi.fn(() => of(kyc)) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new DashboardStatsEffects());
    const results: unknown[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));
    actions$.next(loadDashboardStats());
    expect(results[0]).toEqual(loadDashboardStatsSuccess({ summary, kyc }));
    sub.unsubscribe();
  });

  it('effects emit failure on error', () => {
    const actions$ = new Subject<unknown>();
    const api = {
      getSummary: vi.fn(() => throwError(() => new Error('fail'))),
      getKycDistribution: vi.fn(() => of(kyc)),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new DashboardStatsEffects());
    const results: Array<{ type: string }> = [];
    const sub = effects.load$.subscribe(a => results.push(a));
    actions$.next(loadDashboardStats());
    expect(results[0].type).toBe(loadDashboardStatsFailure.type);
    sub.unsubscribe();
  });
});
