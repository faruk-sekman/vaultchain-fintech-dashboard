/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Guards the ROUTE-LEVEL NgRx wiring, not just DI construction: the facades are providedIn:'root',
 * so `TestBed.inject(XStore) instanceof XStore` passes even with provideState/provideEffects deleted
 * (selecting an unregistered feature just yields undefined). These tests assert the real contract —
 * every slice is registered with its initial state, and a dispatched load action reaches the API
 * through the registered effect.
 */

import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { CustomersApi } from '@core/api/customers.api';
import { ToastService } from '@core/services/toast.service';
import { TransactionsApi } from '@core/api/transactions.api';
import { loadCustomers } from './state/customers/customers.actions';
import {
  customersFeatureKey,
  initialState as customersInitialState,
} from './state/customers/customers.reducer';
import {
  transactionsFeatureKey,
  initialState as transactionsInitialState,
} from './state/transactions/transactions.reducer';
import {
  kycVerificationsFeatureKey,
  initialState as kycVerificationsInitialState,
} from './state/kyc-verifications/kyc-verifications.reducer';
import { provideCustomersState } from './customers.providers';

describe('provideCustomersState', () => {
  function setup() {
    const customersApi = {
      list: vi.fn(() => of({ data: [], total: 0 })),
      delete: vi.fn(() => of(undefined)),
      listKycVerifications: vi.fn(() => of({ data: [], total: 0 })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore(),
        provideCustomersState(),
        { provide: CustomersApi, useValue: customersApi },
        {
          provide: TransactionsApi,
          useValue: { listByCustomerId: vi.fn(() => of({ data: [], total: 0 })) },
        },
        { provide: ToastService, useValue: { success: vi.fn() } },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
      ],
    });
    return { store: TestBed.inject(Store), customersApi };
  }

  function snapshot(store: Store): Record<string, unknown> {
    let state: Record<string, unknown> = {};
    store.subscribe(s => (state = s as Record<string, unknown>)).unsubscribe();
    return state;
  }

  it('registers the customers, transactions, and kycVerifications slices with their initial state', () => {
    const { store } = setup();
    const state = snapshot(store);

    expect(state[customersFeatureKey]).toEqual(customersInitialState);
    expect(state[transactionsFeatureKey]).toEqual(transactionsInitialState);
    expect(state[kycVerificationsFeatureKey]).toEqual(kycVerificationsInitialState);
  });

  it('registers the effects: a dispatched load action reaches the API and lands back in the slice', () => {
    const { store, customersApi } = setup();

    store.dispatch(loadCustomers({ params: { page: 1 } }));

    expect(customersApi.list).toHaveBeenCalledWith({ page: 1 });
    const customers = snapshot(store)[customersFeatureKey] as typeof customersInitialState;
    expect(customers.loading).toBe(false); // success action already reduced by the registered reducer
    expect(customers.lastParams).toEqual({ page: 1 });
  });
});
