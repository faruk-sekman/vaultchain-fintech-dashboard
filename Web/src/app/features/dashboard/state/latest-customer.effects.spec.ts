/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * LatestCustomerEffects: the two dashboard read effects (`load$` = latest-customer KPI card,
 * `loadRecent$` = the top-3 recent-customers card). Each maps its API result to a *Success action and
 * funnels any error through `catchError` into the matching *Failure action (so a failed read never
 * sinks the effect stream). `loadRecent$` additionally maps the masked `DashboardCustomer` DTO into the
 * shared `Customer` shape — exercised here for the `phone ?? ''` and `status === 'ACTIVE'` branches.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Subject, of, throwError } from 'rxjs';
import { LatestCustomerEffects } from './latest-customer.effects';
import { DashboardApi, type DashboardCustomer } from '@core/api/dashboard.api';
import {
  loadLatestCustomer,
  loadLatestCustomerFailure,
  loadLatestCustomerSuccess,
  loadRecentCustomers,
  loadRecentCustomersFailure,
  loadRecentCustomersSuccess,
} from './latest-customer.actions';

function recent(over: Partial<DashboardCustomer> = {}): DashboardCustomer {
  return {
    id: 'c1',
    fullName: 'Ada L***',
    email: 'a***@e***.com',
    phone: '+90 5** *** ** 01',
    kycStatus: 'VERIFIED',
    status: 'ACTIVE',
    riskLevel: 'low',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    ...over,
  };
}

function setup(api: Partial<DashboardApi>) {
  const actions$ = new Subject<unknown>();
  TestBed.configureTestingModule({
    providers: [
      { provide: Actions, useValue: new Actions(actions$ as Subject<never>) },
      { provide: DashboardApi, useValue: api },
    ],
  });
  const effects = TestBed.runInInjectionContext(() => new LatestCustomerEffects());
  return { actions$, effects };
}

describe('LatestCustomerEffects.load$', () => {
  it('maps a successful getLatestCustomer into loadLatestCustomerSuccess', () => {
    const latest = { customer: { id: 'c1' } } as never;
    const { actions$, effects } = setup({ getLatestCustomer: vi.fn(() => of(latest)) });
    const emitted: unknown[] = [];
    const sub = effects.load$.subscribe(a => emitted.push(a));

    actions$.next(loadLatestCustomer());
    expect(emitted).toEqual([loadLatestCustomerSuccess({ latest })]);
    sub.unsubscribe();
  });

  it('passes a null latest through to the success action unchanged (empty read model)', () => {
    const { actions$, effects } = setup({ getLatestCustomer: vi.fn(() => of(null)) });
    const emitted: unknown[] = [];
    const sub = effects.load$.subscribe(a => emitted.push(a));

    actions$.next(loadLatestCustomer());
    expect(emitted).toEqual([loadLatestCustomerSuccess({ latest: null })]);
    sub.unsubscribe();
  });

  it('routes an error into loadLatestCustomerFailure (the stream survives via catchError)', () => {
    const error = new Error('boom');
    const { actions$, effects } = setup({
      getLatestCustomer: vi.fn(() => throwError(() => error)),
    });
    const emitted: unknown[] = [];
    const sub = effects.load$.subscribe(a => emitted.push(a));

    actions$.next(loadLatestCustomer());
    expect(emitted).toEqual([loadLatestCustomerFailure({ error })]);
    sub.unsubscribe();
  });
});

describe('LatestCustomerEffects.loadRecent$', () => {
  it('maps recent customers (active, with phone) into the shared Customer shape', () => {
    const { actions$, effects } = setup({
      getRecentCustomers: vi.fn(() => of([recent({ phone: '+90 5', status: 'ACTIVE' })])),
    });
    const emitted: unknown[] = [];
    const sub = effects.loadRecent$.subscribe(a => emitted.push(a));

    actions$.next(loadRecentCustomers());
    expect(effects).toBeDefined();
    const action = emitted[0] as ReturnType<typeof loadRecentCustomersSuccess>;
    expect(action.type).toBe(loadRecentCustomersSuccess({ customers: [] }).type);
    expect(action.customers).toHaveLength(1);
    expect(action.customers[0].phone).toBe('+90 5');
    expect(action.customers[0].isActive).toBe(true);
    sub.unsubscribe();
  });

  it('defaults a null phone to "" and marks a non-ACTIVE status inactive (mapper branches)', () => {
    const { actions$, effects } = setup({
      getRecentCustomers: vi.fn(() => of([recent({ phone: null, status: 'INACTIVE' })])),
    });
    const emitted: unknown[] = [];
    const sub = effects.loadRecent$.subscribe(a => emitted.push(a));

    actions$.next(loadRecentCustomers());
    const action = emitted[0] as ReturnType<typeof loadRecentCustomersSuccess>;
    expect(action.customers[0].phone).toBe('');
    expect(action.customers[0].isActive).toBe(false);
    sub.unsubscribe();
  });

  it('requests the top 3 and routes an error into loadRecentCustomersFailure', () => {
    const error = new Error('nope');
    const getRecentCustomers = vi.fn(() => throwError(() => error));
    const { actions$, effects } = setup({ getRecentCustomers });
    const emitted: unknown[] = [];
    const sub = effects.loadRecent$.subscribe(a => emitted.push(a));

    actions$.next(loadRecentCustomers());
    expect(getRecentCustomers).toHaveBeenCalledWith(3);
    expect(emitted).toEqual([loadRecentCustomersFailure({ error })]);
    sub.unsubscribe();
  });
});
