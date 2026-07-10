/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { Subject, of, throwError } from 'rxjs';
import { CustomersEffects } from '@features/customers/state/customers/customers.effects';
import { provideMockStore } from '@ngrx/store/testing';
import { CustomersStore } from '@features/customers/state/customers/customers.store';
import {
  deleteCustomer,
  deleteCustomerFailure,
  deleteCustomerSuccess,
  loadCustomers,
  loadCustomersFailure,
  loadCustomersSuccess,
} from '@features/customers/state/customers/customers.actions';
import {
  customersFeatureKey,
  customersReducer,
  initialState,
} from '@features/customers/state/customers/customers.reducer';
import {
  selectCustomersData,
  selectCustomersDeleting,
  selectCustomersDeletingId,
  selectCustomersLastParams,
  selectCustomersLoading,
  selectCustomersTotal,
  selectCustomersError,
  selectCustomersDeleteError,
} from '@features/customers/state/customers/customers.selectors';
import { CustomersApi } from '@core/api/customers.api';
import { ToastService } from '@core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';

const customer = {
  id: '1',
  name: 'A',
  email: 'a@b.com',
  phone: '1',
  walletNumber: 'w',
  nationalId: 1,
  dateOfBirth: '2000-01-01',
  address: { country: '', city: '', postalCode: '', line1: '' },
  kycStatus: 'UNKNOWN',
  isActive: true,
  createdAt: '',
  updatedAt: '',
} as any;

describe('Customers state', () => {
  it('locks the feature key and the action type strings (NgRx registration/devtools contract)', () => {
    expect(customersFeatureKey).toBe('customers');
    expect(loadCustomers.type).toBe('[Customers] Load');
    expect(loadCustomersSuccess.type).toBe('[Customers] Load Success');
    expect(loadCustomersFailure.type).toBe('[Customers] Load Failure');
    expect(deleteCustomer.type).toBe('[Customers] Delete');
    expect(deleteCustomerSuccess.type).toBe('[Customers] Delete Success');
    expect(deleteCustomerFailure.type).toBe('[Customers] Delete Failure');
  });

  it('customersReducer honours the reducer contract (init, unknown action, failure→load error reset)', () => {
    expect(customersReducer(undefined, { type: '@@init' })).toEqual(initialState);

    const state = { ...initialState, data: [customer], total: 1 };
    expect(customersReducer(state, { type: '[Nope] Unknown' })).toBe(state);

    const failed = customersReducer(initialState, loadCustomersFailure({ error: 'x' }));
    const retried = customersReducer(failed, loadCustomers({ params: { page: 1 } }));
    expect(retried.error).toBeNull();
  });

  it('customersReducer handles load and delete actions', () => {
    const loading = customersReducer(initialState, loadCustomers({ params: { page: 1 } }));
    expect(loading.loading).toBe(true);

    const loaded = customersReducer(loading, loadCustomersSuccess({ data: [customer], total: 1 }));
    expect(loaded.data.length).toBe(1);
    expect(loaded.total).toBe(1);

    const deleting = customersReducer(loaded, deleteCustomer({ id: '1' }));
    expect(deleting.deleting).toBe(true);

    const deleted = customersReducer(deleting, deleteCustomerSuccess({ id: '1' }));
    expect(deleted.data.length).toBe(0);
    expect(deleted.deleting).toBe(false);

    const failed = customersReducer(loaded, loadCustomersFailure({ error: 'x' }));
    expect(failed.error).toBe('x');

    const deleteFailed = customersReducer(
      deleting,
      deleteCustomerFailure({ id: '1', error: 'bad' }),
    );
    expect(deleteFailed.deleteError).toBe('bad');
  });

  it('customersReducer keeps total when delete id not found', () => {
    const state = { ...initialState, data: [customer], total: 1 };
    const next = customersReducer(state, deleteCustomerSuccess({ id: '2' }));
    expect(next.total).toBe(1);
    expect(next.data.length).toBe(1);
  });

  it('selectors project state', () => {
    const state = {
      ...initialState,
      data: [customer],
      total: 2,
      loading: true,
      deleting: true,
      deletingId: '1',
    };
    expect(selectCustomersData.projector(state)).toEqual([customer]);
    expect(selectCustomersTotal.projector(state)).toBe(2);
    expect(selectCustomersLoading.projector(state)).toBe(true);
    expect(selectCustomersDeleting.projector(state)).toBe(true);
    expect(selectCustomersDeletingId.projector(state)).toBe('1');
    expect(selectCustomersError.projector({ ...state, error: 'err' })).toBe('err');
    expect(selectCustomersDeleteError.projector({ ...state, deleteError: 'del' })).toBe('del');
    expect(selectCustomersLastParams.projector({ ...state, lastParams: { page: 2 } })).toEqual({
      page: 2,
    });
  });

  it('CustomersStore dispatches actions', () => {
    const actions$ = new Subject<any>();
    const storeMock = { select: vi.fn(() => of([])), dispatch: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Store, useValue: storeMock },
        { provide: Actions, useValue: new Actions(actions$) },
      ],
    });

    const store = TestBed.runInInjectionContext(() => new CustomersStore());
    store.load({ page: 1 });
    store.delete('1');

    expect(storeMock.dispatch).toHaveBeenCalledWith(loadCustomers({ params: { page: 1 } }));
    expect(storeMock.dispatch).toHaveBeenCalledWith(deleteCustomer({ id: '1' }));
  });

  it('CustomersStore.deleteSuccess$ re-emits deleteCustomerSuccess from the actions stream', () => {
    const actions$ = new Subject<any>();
    const storeMock = { select: vi.fn(() => of([])), dispatch: vi.fn() };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Store, useValue: storeMock },
        { provide: Actions, useValue: new Actions(actions$) },
      ],
    });

    const store = TestBed.runInInjectionContext(() => new CustomersStore());
    const emitted: any[] = [];
    const sub = store.deleteSuccess$.subscribe(a => emitted.push(a));

    actions$.next(loadCustomers({ params: { page: 1 } })); // filtered out by ofType
    actions$.next(deleteCustomerSuccess({ id: '1' }));

    expect(emitted).toEqual([deleteCustomerSuccess({ id: '1' })]);
    sub.unsubscribe();
  });

  it('CustomersEffects emits success actions', () => {
    const actions$ = new Subject<any>();
    const api = {
      list: vi.fn(() => of({ data: [customer], total: 1 })),
      delete: vi.fn(() => of({})),
    };
    const toast = { success: vi.fn() };
    const i18n = { instant: (k: string) => k };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: i18n },
        provideMockStore({ initialState: { customers: { lastParams: { page: 3, search: 'x' } } } }),
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new CustomersEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));

    actions$.next(loadCustomers({ params: { page: 1 } }));
    expect(results[0].type).toBe(loadCustomersSuccess.type);

    const delResults: any[] = [];
    const delSub = effects.delete$.subscribe(a => delResults.push(a));
    actions$.next(deleteCustomer({ id: '1' }));
    expect(delResults[0].type).toBe(deleteCustomerSuccess.type);

    const toastSub = effects.deleteSuccessToast$.subscribe();
    actions$.next(deleteCustomerSuccess({ id: '1' }));
    expect(toast.success).toHaveBeenCalledWith('customers.deleted');

    sub.unsubscribe();
    delSub.unsubscribe();
    toastSub.unsubscribe();
  });

  it('A4: customersReducer tracks the last load params for success-effect reloads', () => {
    const state = customersReducer(
      initialState,
      loadCustomers({ params: { page: 2, search: 'ada' } }),
    );
    expect(state.lastParams).toEqual({ page: 2, search: 'ada' });
  });

  it('A4: deleteCustomerSuccess re-dispatches loadCustomers with the CURRENT view params', () => {
    const actions$ = new Subject<any>();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        {
          provide: CustomersApi,
          useValue: { list: vi.fn(() => of({})), delete: vi.fn(() => of({})) },
        },
        { provide: ToastService, useValue: { success: vi.fn() } },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        provideMockStore({ initialState: { customers: { lastParams: { page: 3, search: 'x' } } } }),
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new CustomersEffects());
    const results: any[] = [];
    const sub = effects.reloadAfterDelete$.subscribe(a => results.push(a));

    actions$.next(deleteCustomerSuccess({ id: '1' }));

    expect(results[0]).toEqual(loadCustomers({ params: { page: 3, search: 'x' } }));
    sub.unsubscribe();
  });

  it('A4: the delete reload stays silent before any list load (no params yet)', () => {
    const actions$ = new Subject<any>();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        {
          provide: CustomersApi,
          useValue: { list: vi.fn(() => of({})), delete: vi.fn(() => of({})) },
        },
        { provide: ToastService, useValue: { success: vi.fn() } },
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        provideMockStore({ initialState: { customers: { lastParams: null } } }),
      ],
    });
    const effects = TestBed.runInInjectionContext(() => new CustomersEffects());
    const results: any[] = [];
    const sub = effects.reloadAfterDelete$.subscribe(a => results.push(a));

    actions$.next(deleteCustomerSuccess({ id: '1' }));

    expect(results).toEqual([]);
    sub.unsubscribe();
  });

  it('CustomersEffects defaults missing list data and total', () => {
    const actions$ = new Subject<any>();
    const api = { list: vi.fn(() => of({})), delete: vi.fn(() => of({})) };
    const toast = { success: vi.fn() };
    const i18n = { instant: (k: string) => k };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: i18n },
        provideMockStore({ initialState: { customers: { lastParams: { page: 3, search: 'x' } } } }),
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new CustomersEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));

    actions$.next(loadCustomers({ params: { page: 1 } }));
    expect(results[0]).toEqual(loadCustomersSuccess({ data: [], total: 0 }));

    sub.unsubscribe();
  });

  it('CustomersEffects emits failure actions on errors', () => {
    const actions$ = new Subject<any>();
    const api = {
      list: vi.fn(() => throwError(() => new Error('fail'))),
      delete: vi.fn(() => throwError(() => new Error('fail'))),
    };
    const toast = { success: vi.fn() };
    const i18n = { instant: (k: string) => k };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
        { provide: ToastService, useValue: toast },
        { provide: TranslateService, useValue: i18n },
        provideMockStore({ initialState: { customers: { lastParams: { page: 3, search: 'x' } } } }),
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new CustomersEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));
    actions$.next(loadCustomers({ params: { page: 1 } }));
    expect(results[0].type).toBe(loadCustomersFailure.type);

    const delResults: any[] = [];
    const delSub = effects.delete$.subscribe(a => delResults.push(a));
    actions$.next(deleteCustomer({ id: '1' }));
    expect(delResults[0].type).toBe(deleteCustomerFailure.type);

    sub.unsubscribe();
    delSub.unsubscribe();
  });
});
