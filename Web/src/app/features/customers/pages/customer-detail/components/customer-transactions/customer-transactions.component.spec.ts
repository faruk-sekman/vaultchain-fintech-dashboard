/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { SimpleChange } from '@angular/core';
import {
  CustomerTransactionsComponent,
  TX_CURRENCY_FILTER_OPTIONS,
} from './customer-transactions.component';
import { TransactionsStore } from '@features/customers/state';
import { CatalogApi } from '@core/api/catalog.api';
import { TransactionsApi } from '@core/api/transactions.api';
import { DensityService } from '@core/services/density.service';
import { ToastService } from '@core/services/toast.service';
import { AppErrorService } from '@core/services/app-error.service';
import { TranslateService } from '@ngx-translate/core';

const transactionsStoreMock = {
  data$: of([]),
  total$: of(0),
  loading$: new BehaviorSubject<boolean>(false),
  load: vi.fn(),
};

function catalogApiMock(codes: string[] = ['TRY', 'USD', 'EUR']) {
  return {
    listCurrencies: vi.fn(() => of(codes.map(code => ({ code, name: code, scale: 2 })))),
  } as any;
}

function transactionsApiMock() {
  return { create: vi.fn(() => of({ id: 'tx-1', status: 'POSTED' })) } as any;
}

function make(opts: { loading$?: BehaviorSubject<boolean>; catalog?: any } = {}) {
  const loading$ = opts.loading$ ?? new BehaviorSubject<boolean>(false);
  const transactionsStore = { ...transactionsStoreMock, loading$ } as any;
  const catalogApi = opts.catalog ?? catalogApiMock();
  const transactionsApi = transactionsApiMock();
  const toast = { success: vi.fn(), info: vi.fn() } as any;
  const appError = { handleError: vi.fn() } as any;
  const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;
  const density = { density: () => 'comfortable' } as any;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: TransactionsStore, useValue: transactionsStore },
      { provide: CatalogApi, useValue: catalogApi },
      { provide: TransactionsApi, useValue: transactionsApi },
      { provide: DensityService, useValue: density },
      { provide: ToastService, useValue: toast },
      { provide: AppErrorService, useValue: appError },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new CustomerTransactionsComponent());
  component.customerId = '1';
  return { component, transactionsStore, transactionsApi, toast, appError, loading$ };
}

describe('CustomerTransactionsComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts with only the filter option, then loads currencies from the catalog API', () => {
    const { component } = make();
    // Currencies load in the constructor → options already include the catalog codes.
    expect(component.txCurrencyOptions().map(o => o.value)).toEqual(['', 'TRY', 'USD', 'EUR']);
    expect(component.txCurrencyOptions()[0]).toBe(TX_CURRENCY_FILTER_OPTIONS[0]);
  });

  it('loads page 1 on a customerId change', () => {
    const { component, transactionsStore } = make();
    component.ngOnChanges({ customerId: new SimpleChange(undefined, '1', true) });
    expect(component.txPage()).toBe(1);
    expect(transactionsStore.load).toHaveBeenCalledWith('1', expect.objectContaining({ page: 1 }));
  });

  it('does not load when changes do not carry a non-empty customerId', () => {
    const { component, transactionsStore } = make();
    component.ngOnChanges({});
    component.customerId = '';
    component.ngOnChanges({ customerId: new SimpleChange(undefined, '', true) });
    expect(transactionsStore.load).not.toHaveBeenCalled();
  });

  it('toggles the skeleton off only after a load has started', () => {
    const loading$ = new BehaviorSubject<boolean>(false);
    const { component } = make({ loading$ });
    loading$.next(true);
    expect(component.showTxSkeleton()).toBe(true);
    loading$.next(false);
    expect(component.showTxSkeleton()).toBe(false);
  });

  it('validates transaction range (invalid + half-range block + re-seed on both cleared)', () => {
    const { component } = make();
    const form = new FormGroup({
      from: new FormControl('2024-02-01T00:00'),
      to: new FormControl('2024-01-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;

    expect((component as any).syncTxRangeValidity()).toBe(false);
    expect(form.get('from')?.errors?.['range']).toBe(true);

    // Both cleared → re-seed default range, no range error, valid.
    form.patchValue({ from: '', to: '' });
    expect((component as any).syncTxRangeValidity()).toBe(true);
    expect(form.get('from')?.value).toBeTruthy();
    expect(form.get('from')?.errors).toBeNull();

    // Exactly one bound blank → blocked (mid-edit half-range).
    form.patchValue({ from: '2026-01-01T00:00', to: '' });
    expect((component as any).syncTxRangeValidity()).toBe(false);
  });

  it('accepts a valid range and clears errors; tolerates invalid date strings and missing controls', () => {
    const { component } = make();
    const form = new FormGroup({
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;
    expect((component as any).syncTxRangeValidity()).toBe(true);
    expect(form.get('from')?.errors).toBeNull();

    form.patchValue({ from: 'invalid', to: 'invalid' });
    expect((component as any).syncTxRangeValidity()).toBe(true);

    (component as any).txFiltersForm = {
      form: new FormGroup({ from: new FormControl('2024-01-01T00:00') }),
    };
    expect((component as any).syncTxRangeValidity()).toBe(true);

    (component as any).txFiltersForm = undefined;
    expect((component as any).syncTxRangeValidity()).toBe(true);
  });

  it('dispatches transactions load with enum-typed params (D-13) from the filter form', () => {
    const { component, transactionsStore } = make();
    component.txPage.set(2);
    component.txPageSize.set(20);
    const form = new FormGroup({
      kind: new FormControl('DEPOSIT'),
      status: new FormControl('POSTED'),
      currency: new FormControl('TRY'),
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;

    (component as any).dispatchTransactionsLoad();
    expect(transactionsStore.load).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        page: 2,
        pageSize: 20,
        kind: 'DEPOSIT',
        status: 'POSTED',
        currency: 'TRY',
      }),
    );
  });

  it('treats empty/absent/null filter values as undefined params', () => {
    const { component, transactionsStore } = make();
    component.txFilterInitialValue.set({ kind: '', status: '', currency: '', from: '', to: '' });
    (component as any).txFiltersForm = undefined;
    (component as any).dispatchTransactionsLoad();
    expect(transactionsStore.load).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        kind: undefined,
        status: undefined,
        currency: undefined,
        from: undefined,
        to: undefined,
      }),
    );

    (transactionsStore.load as any).mockClear();
    component.txFilterInitialValue.set(null as any);
    (component as any).dispatchTransactionsLoad();
    expect(transactionsStore.load).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ kind: undefined, status: undefined }),
    );
  });

  it('txColumns map real kind/status to badge colors and fall back to gray', () => {
    const { component } = make();
    const kindCol = component.txColumns[1];
    const statusCol = component.txColumns[2];
    expect(kindCol.key).toBe('kind');
    expect(statusCol.key).toBe('status');
    expect(kindCol.badgeColor?.('DEPOSIT', {} as any)).toBe('green');
    expect(kindCol.badgeColor?.('WITHDRAWAL', {} as any)).toBe('blue');
    expect(kindCol.badgeColor?.('FEE', {} as any)).toBe('yellow');
    expect(statusCol.badgeColor?.('POSTED', {} as any)).toBe('green');
    expect(statusCol.badgeColor?.('FAILED', {} as any)).toBe('red');
    expect(kindCol.badgeColor?.('UNKNOWN', {} as any)).toBe('gray');
    expect(statusCol.badgeColor?.('UNKNOWN', {} as any)).toBe('gray');

    // The badge cells also resolve a translated label via each column's `formatter` (i18n stub echoes
    // the key) — the kind/status formatter arrows that the badgeColor-only assertions never touched.
    expect(kindCol.formatter?.('DEPOSIT', {} as any)).toBe('transactions.kinds.DEPOSIT');
    expect(statusCol.formatter?.('POSTED', {} as any)).toBe('transactions.statuses.POSTED');
  });

  it('the wallet getter reflects the last value pushed through the setter', () => {
    const { component } = make();
    expect(component.wallet).toBeNull();
    const wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    component.wallet = wallet;
    // The getter reads the backing `_wallet` signal the setter wrote.
    expect(component.wallet).toEqual(wallet);
  });

  it('transaction-create offers only DEPOSIT + WITHDRAWAL (no FEE)', () => {
    const { component } = make();
    const kindField = component.txCreateFields.find(f => f.name === 'kind');
    const values = (kindField?.options ?? []).map(o => o.value);
    expect(values).toEqual(['DEPOSIT', 'WITHDRAWAL']);
    expect(values).not.toContain('FEE');
  });

  it('onTxPageChange updates page + size and dispatches a reload (valid range)', () => {
    const { component, transactionsStore } = make();
    component.onTxPageChange({ page: 3, pageSize: 50 });
    expect(component.txPage()).toBe(3);
    expect(component.txPageSize()).toBe(50);
    expect(transactionsStore.load).toHaveBeenCalledWith('1', expect.objectContaining({ page: 3 }));
  });

  it('C-1: a pager page-click does NOT dispatch a load while a date bound is half-cleared', () => {
    // The original guarded manual reloads via txReload$.pipe(filter(syncTxRangeValidity)); a
    // half-range (exactly one bound blank) the required-range backend would 400 on must be skipped.
    const { component, transactionsStore } = make();
    const form = new FormGroup({
      from: new FormControl('2026-01-01T00:00'),
      to: new FormControl(''),
    });
    (component as any).txFiltersForm = { form } as any;

    component.onTxPageChange({ page: 2, pageSize: 10 });
    // Page signal still advances (matches the original: txPage was set before the guarded reload)...
    expect(component.txPage()).toBe(2);
    // ...but NO server load is dispatched while the range is incomplete.
    expect(transactionsStore.load).not.toHaveBeenCalled();
  });

  it('clearTxFilters resets the form (or initial value) to defaults and reloads', () => {
    const { component, transactionsStore } = make();
    const form = new FormGroup({
      kind: new FormControl('DEPOSIT'),
      status: new FormControl(''),
      currency: new FormControl(''),
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;
    component.clearTxFilters();
    expect(component.txPage()).toBe(1);
    expect(form.get('kind')?.value).toBe('');
    expect(transactionsStore.load).toHaveBeenCalled();

    // No form mounted yet → seeds the initial value and still reloads.
    (transactionsStore.load as any).mockClear();
    (component as any).txFiltersForm = undefined;
    component.clearTxFilters();
    expect(component.txFilterInitialValue()).toBeTruthy();
    expect(transactionsStore.load).toHaveBeenCalled();
  });

  it('setupTxStream wires filter changes once and reloads through the same path', () => {
    vi.useFakeTimers();
    const { component, transactionsStore } = make();
    const form = new FormGroup({
      kind: new FormControl(''),
      status: new FormControl(''),
      currency: new FormControl(''),
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;

    component.ngAfterViewInit();
    // Re-invoking is idempotent (guard) — no double wiring.
    component.ngAfterViewInit();
    form.patchValue({ kind: 'WITHDRAWAL' });
    vi.advanceTimersByTime(300);
    expect(transactionsStore.load).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('setupTxStream safely exits when the filter form is missing', () => {
    const { component } = make();
    (component as any).txFiltersForm = undefined;
    expect(() => (component as any).setupTxStream()).not.toThrow();
  });

  it('filter stream survives ui-form rebinding currency OPTIONS (name-stable rebuild invariant)', () => {
    // Regression for the latent invariant: ui-form rebuilds its FormGroup only on field-NAME change.
    // The async catalog load swaps `currency` options (not names), so the SAME FormGroup the stream
    // subscribed to in ngAfterViewInit stays live. Prove a patch AFTER the options rebind still loads.
    vi.useFakeTimers();
    const { component, transactionsStore } = make();
    const form = new FormGroup({
      kind: new FormControl(''),
      status: new FormControl(''),
      currency: new FormControl(''),
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;

    component.ngAfterViewInit(); // wires the stream to THIS FormGroup
    // Simulate a late catalog response updating the field list (options-only change; same group).
    (component as any).loadCurrencyOptions();
    expect(component.txFilterFields().find(f => f.name === 'currency')?.options?.length).toBe(4);

    // The live form is unchanged → a value change still flows through to a load.
    form.patchValue({ kind: 'DEPOSIT' });
    vi.advanceTimersByTime(300);
    expect(transactionsStore.load).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('createTransaction guards an absent form / invalid amount, then posts a valid one and asks to reload the wallet', () => {
    const { component, transactionsApi, toast } = make();
    // No txCreateForm yet → early return, no throw.
    expect(() => component.createTransaction()).not.toThrow();

    const wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' };
    component.wallet = wallet as any;

    // Invalid amount (0) → returns before the API call.
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl('DEPOSIT'),
        amount: new FormControl(0),
        description: new FormControl(''),
      }),
    };
    component.createTransaction();
    expect(transactionsApi.create).not.toHaveBeenCalled();

    const reloadSpy = vi.fn();
    component.walletShouldReload.subscribe(reloadSpy);

    // Valid amount → posts, toasts, asks for a wallet reload, clears the in-flight flag.
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl('DEPOSIT'),
        amount: new FormControl(125),
        description: new FormControl('salary'),
      }),
    };
    component.createTransaction();
    expect(transactionsApi.create).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('transactions.create.created');
    expect(reloadSpy).toHaveBeenCalled();
    expect(component.creatingTransaction()).toBe(false);
  });

  it('createTransaction marks an invalid form and exits before calling the API', () => {
    const { component, transactionsApi } = make();
    component.wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl('', { validators: [Validators.required] }),
        amount: new FormControl(null, { validators: [Validators.required] }),
        description: new FormControl(''),
      }),
    };

    component.createTransaction();

    expect(transactionsApi.create).not.toHaveBeenCalled();
  });

  it('defaults a missing transaction kind to DEPOSIT and tolerates missing filter date controls after create', () => {
    const { component, transactionsApi, transactionsStore } = make();
    component.wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl(null),
        amount: new FormControl(10),
        description: new FormControl('  default kind  '),
      }),
    };
    (component as any).txFiltersForm = {
      form: new FormGroup({ kind: new FormControl('') }),
    };

    component.createTransaction();

    const [body] = transactionsApi.create.mock.calls[0];
    expect(body).toMatchObject({
      kind: 'DEPOSIT',
      targetWalletId: 'w1',
      description: 'default kind',
    });
    const [, params] = transactionsStore.load.mock.calls.at(-1);
    expect(params.from).toBeUndefined();
    expect(params.to).toBeUndefined();
  });

  it('routes a create failure through AppErrorService and clears the in-flight flag (no false success)', () => {
    const { component, transactionsApi, toast, appError } = make();
    // The POST rejects → the catchError arm logs via AppErrorService, no success toast, flag cleared.
    transactionsApi.create.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl('DEPOSIT'),
        amount: new FormControl(50),
        description: new FormControl(''),
      }),
    };

    component.createTransaction();

    expect(appError.handleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'createTransaction' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(component.creatingTransaction()).toBe(false);
  });

  it('keeps the default currency option (only "common.all") when the catalog load fails', () => {
    // listCurrencies rejects → the loadCurrencyOptions catchError swallows it and the options stay at
    // the single filter-only entry (no crash, no empty dropdown). Exercises the catalog catchError arm.
    const { component } = make({
      catalog: { listCurrencies: vi.fn(() => throwError(() => new Error('catalog down'))) },
    });
    expect(component.txCurrencyOptions().map(o => o.value)).toEqual(['']);
    expect(component.txCurrencyOptions()[0]).toBe(TX_CURRENCY_FILTER_OPTIONS[0]);
  });

  it('the filter stream de-duplicates an identical value emission (distinctUntilChanged comparator)', () => {
    vi.useFakeTimers();
    const { component, transactionsStore } = make();
    const form = new FormGroup({
      kind: new FormControl(''),
      status: new FormControl(''),
      currency: new FormControl(''),
      from: new FormControl('2024-01-01T00:00'),
      to: new FormControl('2024-02-01T00:00'),
    });
    (component as any).txFiltersForm = { form } as any;
    component.ngAfterViewInit();

    // First real change → one load after the debounce settles.
    form.patchValue({ kind: 'DEPOSIT' });
    vi.advanceTimersByTime(300);
    expect(transactionsStore.load).toHaveBeenCalledTimes(1);

    // Re-emitting the SAME value (JSON-equal) → the comparator returns true → no extra load.
    (transactionsStore.load as any).mockClear();
    form.patchValue({ kind: 'DEPOSIT' });
    vi.advanceTimersByTime(300);
    expect(transactionsStore.load).not.toHaveBeenCalled();

    // A genuinely different value → the comparator returns false → a load fires again.
    form.patchValue({ kind: 'WITHDRAWAL' });
    vi.advanceTimersByTime(300);
    expect(transactionsStore.load).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  describe('A5 — post-create reload is guaranteed and range-fresh', () => {
    const wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    const createForm = () =>
      ({
        form: new FormGroup({
          kind: new FormControl('DEPOSIT'),
          amount: new FormControl(50),
          description: new FormControl(''),
        }),
      }) as any;
    const filtersForm = (values: Record<string, string>) =>
      ({
        form: new FormGroup({
          kind: new FormControl(values['kind'] ?? ''),
          status: new FormControl(values['status'] ?? ''),
          currency: new FormControl(values['currency'] ?? ''),
          from: new FormControl(values['from'] ?? ''),
          to: new FormControl(values['to'] ?? ''),
        }),
      }) as any;

    it('dispatches the reload even when a date bound is half-cleared (old silent-skip bug)', () => {
      const { component, transactionsStore } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      (component as any).txFiltersForm = filtersForm({ from: '2026-01-01T00:00', to: '' });

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ page: 1 }),
      );
      // The broken half-range was re-seeded to a complete default range before dispatching.
      const form = (component as any).txFiltersForm.form;
      expect(form.get('from')?.value).toBeTruthy();
      expect(form.get('to')?.value).toBeTruthy();
    });

    it('re-seeds a PRISTINE (untouched) stale range so the fresh record falls inside the bound', () => {
      const { component, transactionsStore } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      // Programmatic values keep the controls pristine — exactly like the page-load default.
      (component as any).txFiltersForm = filtersForm({
        from: '2024-01-01T00:00',
        to: '2024-02-01T00:00',
      });

      component.createTransaction();

      const params = (transactionsStore.load as any).mock.calls.at(-1)[1];
      // The stale `to` was replaced by a fresh bound at/after "now" (ceiled to the next minute).
      expect(new Date(params.to).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
      expect(transactionsStore.load).toHaveBeenCalled();
    });

    it('preserves a USER-SET (dirty) valid range and explains via info toast when it hides the record', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      const filters = filtersForm({ from: '2024-01-01T00:00', to: '2024-02-01T00:00' });
      filters.form.get('from')!.markAsDirty();
      filters.form.get('to')!.markAsDirty();
      (component as any).txFiltersForm = filters;

      component.createTransaction();

      const params = (transactionsStore.load as any).mock.calls.at(-1)[1];
      expect(params.from).toBe('2024-01-01T00:00');
      expect(params.to).toBe('2024-02-01T00:00');
      expect(toast.info).toHaveBeenCalledWith('transactions.create.filteredOut');
    });

    it('warns when the active kind filter excludes the created kind, still reloading', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm(); // creates a DEPOSIT
      (component as any).txFiltersForm = filtersForm({ kind: 'WITHDRAWAL' });

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('transactions.create.filteredOut');
    });

    it('warns when the active status filter excludes the posted transaction', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      (component as any).txFiltersForm = filtersForm({ status: 'FAILED' });

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('transactions.create.filteredOut');
    });

    it('warns when the active currency filter excludes the wallet currency', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      (component as any).txFiltersForm = filtersForm({ currency: 'USD' });

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('transactions.create.filteredOut');
    });

    it('warns when the active user-set from-date is in the future', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      const future = new Date(Date.now() + 10 * 60 * 1000);
      const filters = filtersForm({
        from: (component as any).toDateTimeLocal(future),
        to: (component as any).toDateTimeLocal(new Date(future.getTime() + 60_000)),
      });
      filters.form.get('from')!.markAsDirty();
      filters.form.get('to')!.markAsDirty();
      (component as any).txFiltersForm = filters;

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('transactions.create.filteredOut');
    });

    it('shows NO filtered-out warning on the fresh default filters', () => {
      const { component, transactionsStore, toast } = make();
      component.wallet = wallet;
      (component as any).txCreateForm = createForm();
      const defaults = (component as any).buildTxFilterInitialValue();
      (component as any).txFiltersForm = filtersForm(defaults);

      component.createTransaction();

      expect(transactionsStore.load).toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });
  });

  it('builds a WITHDRAWAL create request with sourceWalletId (not target)', () => {
    const { component, transactionsApi } = make();
    component.wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
    (component as any).txCreateForm = {
      form: new FormGroup({
        kind: new FormControl('WITHDRAWAL'),
        amount: new FormControl(40),
        description: new FormControl(''),
      }),
    };
    component.createTransaction();
    const [body] = transactionsApi.create.mock.calls[0];
    expect(body.kind).toBe('WITHDRAWAL');
    expect(body.sourceWalletId).toBe('w1');
    expect(body.targetWalletId).toBeUndefined();
  });

  it('formats date time local', () => {
    const { component } = make();
    const result = (component as any).toDateTimeLocal(new Date('2024-01-02T03:04:00Z'));
    expect(result).toContain('2024-01-');
  });

  it('buildTxFilterInitialValue returns a from/to range', () => {
    const { component } = make();
    const initial = (component as any).buildTxFilterInitialValue();
    expect(initial).toHaveProperty('from');
    expect(initial).toHaveProperty('to');
  });

  it('preserves a non-range error on a date control when clearing the range flag', () => {
    // from < to (valid range) clears `range`, but a co-existing custom error must remain.
    const { component } = make();
    const fromCtrl = new FormControl('2024-01-01T00:00');
    const toCtrl = new FormControl('2024-02-01T00:00');
    fromCtrl.setErrors({ range: true, custom: true });
    const form = new FormGroup({ from: fromCtrl, to: toCtrl });
    (component as any).txFiltersForm = { form } as any;

    expect((component as any).syncTxRangeValidity()).toBe(true);
    expect(fromCtrl.errors).toEqual({ custom: true });
  });

  it('clears range-only errors completely once the date range becomes valid', () => {
    const { component } = make();
    const fromCtrl = new FormControl('2024-01-01T00:00');
    const toCtrl = new FormControl('2024-02-01T00:00');
    fromCtrl.setErrors({ range: true });
    toCtrl.setErrors({ range: true });
    (component as any).txFiltersForm = { form: new FormGroup({ from: fromCtrl, to: toCtrl }) };

    expect((component as any).syncTxRangeValidity()).toBe(true);
    expect(fromCtrl.errors).toBeNull();
    expect(toCtrl.errors).toBeNull();
  });

  it('C-2: re-seeds the create form only when the wallet id changes, not on a same-id push', () => {
    const { component } = make();
    const resetSpy = vi.fn();
    (component as any).txCreateForm = {
      form: {
        reset: resetSpy,
        markAsPristine: vi.fn(),
        markAsUntouched: vi.fn(),
        updateValueAndValidity: vi.fn(),
      },
    };

    // First wallet (id w1) → resets the create form once.
    component.wallet = { id: 'w1', currency: 'TRY', balance: 0 } as any;
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledWith(
      { kind: 'DEPOSIT', amount: null, description: '' },
      { emitEvent: false },
    );

    // Same id, new object reference (e.g. the container mirroring a limit-save) → NO reset, so a
    // half-typed create form survives across columns (the UX regression this guards).
    component.wallet = { id: 'w1', currency: 'TRY', balance: 999, dailyLimit: 5 } as any;
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // A genuinely different wallet (id w2) → resets again.
    component.wallet = { id: 'w2', currency: 'TRY', balance: 0 } as any;
    expect(resetSpy).toHaveBeenCalledTimes(2);

    // Clearing the wallet should not wipe a half-typed create form, but the getter reflects null.
    component.wallet = null;
    expect(resetSpy).toHaveBeenCalledTimes(2);
    expect(component.wallet).toBeNull();
  });

  it('falls back to a v4-shaped uuid when crypto.randomUUID is unavailable', () => {
    // Exercise the non-crypto branch of the module-private randomUuid via a stubbed global.
    vi.stubGlobal('crypto', undefined);
    try {
      const { component, transactionsApi } = make();
      component.wallet = { id: 'w1', currency: 'TRY', balance: 1000, status: 'ACTIVE' } as any;
      (component as any).txCreateForm = {
        form: new FormGroup({
          kind: new FormControl('DEPOSIT'),
          amount: new FormControl(10),
          description: new FormControl(''),
        }),
      };
      component.createTransaction();
      const [, idemKey] = transactionsApi.create.mock.calls[0];
      expect(idemKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
