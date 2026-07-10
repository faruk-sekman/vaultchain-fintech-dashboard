/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { Subject, of, throwError } from 'rxjs';
import { KycVerificationsEffects } from '@features/customers/state/kyc-verifications/kyc-verifications.effects';
import { KycVerificationsStore } from '@features/customers/state/kyc-verifications/kyc-verifications.store';
import {
  loadKycVerifications,
  loadKycVerificationsFailure,
  loadKycVerificationsSuccess,
} from '@features/customers/state/kyc-verifications/kyc-verifications.actions';
import {
  kycVerificationsFeatureKey,
  kycVerificationsReducer,
  initialState,
} from '@features/customers/state/kyc-verifications/kyc-verifications.reducer';
import {
  selectKycVerificationsData,
  selectKycVerificationsLoading,
  selectKycVerificationsTotal,
  selectKycVerificationsError,
} from '@features/customers/state/kyc-verifications/kyc-verifications.selectors';
import { CustomersApi } from '@core/api/customers.api';

const kyc = {
  id: '1',
  customerId: 'c1',
  status: 'VERIFIED',
  method: 'DOCUMENT',
  reasonCode: null,
  decidedAt: '',
  decidedBy: null,
  createdAt: '',
} as any;

describe('KycVerifications state', () => {
  it('locks the feature key and the action type strings (NgRx registration/devtools contract)', () => {
    expect(kycVerificationsFeatureKey).toBe('kycVerifications');
    expect(loadKycVerifications.type).toBe('[KycVerifications] Load');
    expect(loadKycVerificationsSuccess.type).toBe('[KycVerifications] Load Success');
    expect(loadKycVerificationsFailure.type).toBe('[KycVerifications] Load Failure');
  });

  it('kycVerificationsReducer honours the reducer contract (init, unknown action, failure→load error reset)', () => {
    expect(kycVerificationsReducer(undefined, { type: '@@init' })).toEqual(initialState);

    const state = { ...initialState, data: [kyc], total: 1 };
    expect(kycVerificationsReducer(state, { type: '[Nope] Unknown' })).toBe(state);

    const failed = kycVerificationsReducer(
      initialState,
      loadKycVerificationsFailure({ error: 'x' }),
    );
    const retried = kycVerificationsReducer(
      failed,
      loadKycVerifications({ customerId: '1', params: { page: 1 } }),
    );
    expect(retried.error).toBeNull();
  });

  it('kycVerificationsReducer handles load actions', () => {
    const loading = kycVerificationsReducer(
      initialState,
      loadKycVerifications({ customerId: '1', params: { page: 1 } }),
    );
    expect(loading.loading).toBe(true);

    const loaded = kycVerificationsReducer(
      loading,
      loadKycVerificationsSuccess({ data: [kyc], total: 1 }),
    );
    expect(loaded.data.length).toBe(1);
    expect(loaded.loading).toBe(false);

    const failed = kycVerificationsReducer(loaded, loadKycVerificationsFailure({ error: 'x' }));
    expect(failed.error).toBe('x');
  });

  it('selectors project state', () => {
    const state = { ...initialState, data: [kyc], total: 2, loading: true };
    expect(selectKycVerificationsData.projector(state)).toEqual([kyc]);
    expect(selectKycVerificationsTotal.projector(state)).toBe(2);
    expect(selectKycVerificationsLoading.projector(state)).toBe(true);
    expect(selectKycVerificationsError.projector({ ...state, error: 'err' })).toBe('err');
  });

  it('KycVerificationsStore dispatches actions', () => {
    const actions$ = new Subject<any>();
    const storeMock = { select: vi.fn(() => of([])), dispatch: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Store, useValue: storeMock },
        { provide: Actions, useValue: new Actions(actions$) },
      ],
    });

    const store = TestBed.runInInjectionContext(() => new KycVerificationsStore());
    store.load('1', { page: 1 });
    expect(storeMock.dispatch).toHaveBeenCalledWith(
      loadKycVerifications({ customerId: '1', params: { page: 1 } }),
    );
  });

  it('KycVerificationsEffects emits success action', () => {
    const actions$ = new Subject<any>();
    const api = { listKycVerifications: vi.fn(() => of({ data: [kyc], total: 1 })) };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new KycVerificationsEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));

    actions$.next(loadKycVerifications({ customerId: '1', params: { page: 1 } }));
    // The effect forwards the action's customerId + params verbatim to the API read.
    expect(api.listKycVerifications).toHaveBeenCalledWith('1', { page: 1 });
    expect(results[0].type).toBe(loadKycVerificationsSuccess.type);

    sub.unsubscribe();
  });

  it('KycVerificationsEffects defaults missing list data and total', () => {
    const actions$ = new Subject<any>();
    const api = { listKycVerifications: vi.fn(() => of({})) };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new KycVerificationsEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));

    actions$.next(loadKycVerifications({ customerId: '1', params: { page: 1 } }));
    expect(results[0]).toEqual(loadKycVerificationsSuccess({ data: [], total: 0 }));

    sub.unsubscribe();
  });

  it('KycVerificationsEffects emits failure action on error', () => {
    const actions$ = new Subject<any>();
    const api = { listKycVerifications: vi.fn(() => throwError(() => new Error('fail'))) };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: CustomersApi, useValue: api },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new KycVerificationsEffects());
    const results: any[] = [];
    const sub = effects.load$.subscribe(a => results.push(a));

    actions$.next(loadKycVerifications({ customerId: '1', params: { page: 1 } }));
    expect(results[0].type).toBe(loadKycVerificationsFailure.type);

    sub.unsubscribe();
  });
});
