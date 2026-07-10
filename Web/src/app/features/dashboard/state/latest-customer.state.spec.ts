/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { Subject, of, throwError } from 'rxjs';
import { LatestCustomerEffects } from '@features/dashboard/state/latest-customer.effects';
import { LatestCustomerStore } from '@features/dashboard/state/latest-customer.store';
import {
  loadLatestCustomer,
  loadLatestCustomerFailure,
  loadLatestCustomerSuccess,
  loadRecentCustomers,
  loadRecentCustomersFailure,
  loadRecentCustomersSuccess,
} from '@features/dashboard/state/latest-customer.actions';
import {
  latestCustomerFeatureKey,
  latestCustomerReducer,
  initialState,
} from '@features/dashboard/state/latest-customer.reducer';
import {
  selectLatestCustomer,
  selectLatestCustomerError,
  selectLatestCustomerLoaded,
  selectLatestCustomerLoading,
  selectRecentCustomers,
  selectRecentCustomersError,
  selectRecentCustomersLoaded,
  selectRecentCustomersLoading,
} from '@features/dashboard/state/latest-customer.selectors';
import { DashboardApi, LatestCustomer } from '@core/api/dashboard.api';
import { Customer } from '@shared/models/customer.model';

const latest: LatestCustomer = {
  customer: {
    id: '1',
    fullName: 'Ada Lovelace',
    email: 'a***@e***.com',
    phone: '*** *** 4567',
    kycStatus: 'VERIFIED',
    status: 'ACTIVE',
    riskLevel: 'LOW',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
  wallet: { currency: 'TRY', balanceMinor: '12500' },
};

const recentCustomers: Customer[] = [
  {
    id: '1',
    name: 'Ada Lovelace',
    email: 'a***@e***.com',
    phone: '*** *** 4567',
    walletNumber: '',
    dateOfBirth: '',
    nationalId: '',
    address: { country: '', city: '', postalCode: '', line1: '' },
    kycStatus: 'VERIFIED',
    isActive: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
];

describe('LatestCustomer state', () => {
  it('locks the feature key and the action type strings (NgRx registration/devtools contract)', () => {
    expect(latestCustomerFeatureKey).toBe('latestCustomer');
    expect(loadLatestCustomer.type).toBe('[Dashboard] Load Latest Customer');
    expect(loadLatestCustomerSuccess.type).toBe('[Dashboard] Load Latest Customer Success');
    expect(loadLatestCustomerFailure.type).toBe('[Dashboard] Load Latest Customer Failure');
    expect(loadRecentCustomers.type).toBe('[Dashboard] Load Recent Customers');
    expect(loadRecentCustomersSuccess.type).toBe('[Dashboard] Load Recent Customers Success');
    expect(loadRecentCustomersFailure.type).toBe('[Dashboard] Load Recent Customers Failure');
  });

  it('reducer honours the reducer contract (init, unknown action, failure→load error resets)', () => {
    expect(latestCustomerReducer(undefined, { type: '@@init' })).toEqual(initialState);

    const state = { ...initialState, latest, recent: recentCustomers };
    expect(latestCustomerReducer(state, { type: '[Nope] Unknown' })).toBe(state);

    // Each error arm clears on its own re-load.
    const failedLatest = latestCustomerReducer(
      initialState,
      loadLatestCustomerFailure({ error: 'x' }),
    );
    expect(latestCustomerReducer(failedLatest, loadLatestCustomer()).error).toBeNull();

    const failedRecent = latestCustomerReducer(
      initialState,
      loadRecentCustomersFailure({ error: 'y' }),
    );
    expect(latestCustomerReducer(failedRecent, loadRecentCustomers()).recentError).toBeNull();
  });

  it('reducer handles load / success / failure', () => {
    const loading = latestCustomerReducer(initialState, loadLatestCustomer());
    expect(loading.loading).toBe(true);

    const loaded = latestCustomerReducer(loading, loadLatestCustomerSuccess({ latest }));
    expect(loaded.latest).toEqual(latest);
    expect(loaded.loaded).toBe(true);

    const empty = latestCustomerReducer(initialState, loadLatestCustomerSuccess({ latest: null }));
    expect(empty.latest).toBeNull();
    expect(empty.loaded).toBe(true);

    const failed = latestCustomerReducer(loaded, loadLatestCustomerFailure({ error: 'x' }));
    expect(failed.error).toBe('x');
  });

  it('reducer handles the recent-customers load / success / failure (v2.1 Recent Customers)', () => {
    const loading = latestCustomerReducer(initialState, loadRecentCustomers());
    expect(loading.recentLoading).toBe(true);
    expect(loading.recentLoaded).toBe(false);

    const loaded = latestCustomerReducer(
      loading,
      loadRecentCustomersSuccess({ customers: recentCustomers }),
    );
    expect(loaded.recent).toEqual(recentCustomers);
    expect(loaded.recentLoaded).toBe(true);
    expect(loaded.recentError).toBeNull();

    const failed = latestCustomerReducer(loaded, loadRecentCustomersFailure({ error: 'boom' }));
    expect(failed.recentError).toBe('boom');
    expect(failed.recentLoading).toBe(false);
    // The legacy latest slice is untouched by the recent flow.
    expect(failed.latest).toBeNull();
  });

  it('selectors project state', () => {
    const state = {
      ...initialState,
      latest,
      loading: true,
      loaded: false,
      error: 'x',
      recent: recentCustomers,
      recentLoading: true,
      recentLoaded: false,
      recentError: 'y',
    };
    expect(selectLatestCustomer.projector(state)).toEqual(latest);
    expect(selectLatestCustomerLoading.projector(state)).toBe(true);
    expect(selectLatestCustomerLoaded.projector(state)).toBe(false);
    expect(selectLatestCustomerError.projector(state)).toBe('x');
    expect(selectRecentCustomers.projector(state)).toEqual(recentCustomers);
    expect(selectRecentCustomersLoading.projector(state)).toBe(true);
    expect(selectRecentCustomersLoaded.projector(state)).toBe(false);
    expect(selectRecentCustomersError.projector(state)).toBe('y');
  });

  it('store dispatches load + loadRecent', () => {
    const storeMock = { select: vi.fn(() => of(null)), dispatch: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: Store, useValue: storeMock }] });
    const store = TestBed.runInInjectionContext(() => new LatestCustomerStore());
    store.load();
    expect(storeMock.dispatch).toHaveBeenCalledWith(loadLatestCustomer());
    store.loadRecent();
    expect(storeMock.dispatch).toHaveBeenCalledWith(loadRecentCustomers());
  });

  it('effects emit success', () => {
    const actions$ = new Subject<unknown>();
    const api = { getLatestCustomer: vi.fn(() => of(latest)) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
    const results: unknown[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));
    actions$.next(loadLatestCustomer());
    expect(results[0]).toEqual(loadLatestCustomerSuccess({ latest }));
    sub.unsubscribe();
  });

  it('effects emit failure on error', () => {
    const actions$ = new Subject<unknown>();
    const api = { getLatestCustomer: vi.fn(() => throwError(() => new Error('fail'))) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
    const results: Array<{ type: string }> = [];
    const sub = effects.load$.subscribe(a => results.push(a));
    actions$.next(loadLatestCustomer());
    expect(results[0].type).toBe(loadLatestCustomerFailure.type);
    sub.unsubscribe();
  });

  it('loadRecent$ reads /dashboard/recent-customers (top 3) and emits the masked recent rows', () => {
    const actions$ = new Subject<unknown>();
    const api = { getRecentCustomers: vi.fn(() => of([latest.customer])) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
    const results: unknown[] = [];
    const sub = effects.loadRecent$.subscribe(a => results.push(a));
    actions$.next(loadRecentCustomers());
    expect(api.getRecentCustomers).toHaveBeenCalledWith(3);
    expect(results[0]).toEqual(loadRecentCustomersSuccess({ customers: recentCustomers }));
    sub.unsubscribe();
  });

  it('loadRecent$ emits an empty recent list when there are no recent customers', () => {
    const actions$ = new Subject<unknown>();
    const api = { getRecentCustomers: vi.fn(() => of([])) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
    const results: unknown[] = [];
    const sub = effects.loadRecent$.subscribe(a => results.push(a));
    actions$.next(loadRecentCustomers());
    expect(results[0]).toEqual(loadRecentCustomersSuccess({ customers: [] }));
    sub.unsubscribe();
  });

  it('loadRecent$ emits failure on error', () => {
    const actions$ = new Subject<unknown>();
    const api = { getRecentCustomers: vi.fn(() => throwError(() => new Error('fail'))) };
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: DashboardApi, useValue: api },
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
    const results: Array<{ type: string }> = [];
    const sub = effects.loadRecent$.subscribe(a => results.push(a));
    actions$.next(loadRecentCustomers());
    expect(results[0].type).toBe(loadRecentCustomersFailure.type);
    sub.unsubscribe();
  });
});
