/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY } from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  filter,
  finalize,
  tap,
} from 'rxjs/operators';

import { CatalogApi } from '@core/api/catalog.api';
import {
  CreateTransactionRequest,
  ListTransactionsParams,
  TransactionsApi,
} from '@core/api/transactions.api';
import { DensityService } from '@core/services/density.service';
import { ToastService } from '@core/services/toast.service';
import { AppErrorService } from '@core/services/app-error.service';

import { Wallet } from '@shared/models/wallet.model';
import { Transaction, TransactionKind, TransactionStatus } from '@shared/models/transaction.model';
import { majorToMinor } from '@shared/utils/money';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiFormComponent } from '@shared/components/ui-form/ui-form.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { UiTableComponent } from '@shared/components/ui-table/ui-table.component';
import { ColumnDef } from '@shared/components/ui-table/ui-table.types';
import { FieldConfig, SelectOption } from '@shared/components/ui-form/ui-form.types';
import {
  getTxKindBadgeColor,
  getTxStatusBadgeColor,
  txKindLabelKey,
  txStatusLabelKey,
  TX_KIND_FILTER_OPTIONS,
  TX_STATUS_FILTER_OPTIONS,
} from '@shared/utils/transaction-status';
import { TransactionsStore } from '@features/customers/state';

// 'common.all' is the filter-only "no filter" entry. Real currency options are loaded from
// GET /catalog/currencies; no seed/static currency list is kept in the FE.
export const TX_CURRENCY_FILTER_OPTIONS: SelectOption[] = [{ labelKey: 'common.all', value: '' }];

// Operator quick-create offers only the two operator-initiated flows. FEE/adjustment/reversal are
// system-generated ledger flows, not an operator action (audit fn-fee-in-create).
const TX_CREATE_KIND_OPTIONS: SelectOption[] = [
  { labelKey: txKindLabelKey('DEPOSIT'), value: 'DEPOSIT' },
  { labelKey: txKindLabelKey('WITHDRAWAL'), value: 'WITHDRAWAL' },
];

/**
 * Transactions panel: the operator quick-create form, the ledger filter toolbar, and the paginated
 * table (audit Y-4). Extracted from the customer-detail god-component.
 *
 * Owning the filter form's own lifecycle removed the former dead-pager ViewChild-setter timing hack:
 * the filter form lives in THIS component's template for its whole life (toggled by visibility, not
 * by `@if`), so the filter/reload stream wires once in ngAfterViewInit — page clicks, filter edits,
 * and clear all reload through the same path. Store-backed (the shared transactions slice).
 */
@Component({
  selector: 'app-customer-transactions',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiButtonComponent,
    UiFormComponent,
    UiSkeletonComponent,
    UiTableComponent,
  ],
  templateUrl: './customer-transactions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'enterprise-panel', id: 'customer-detail-transactions-card' },
})
export class CustomerTransactionsComponent implements OnChanges, AfterViewInit {
  /** Customer whose transactions this panel lists; a change re-seeds page 1 and reloads. */
  @Input({ required: true }) customerId!: string;
  /** The customer's wallet — required to create a transaction; null disables create + warns. */
  @Input() set wallet(value: Wallet | null) {
    this._wallet.set(value);
    // Re-seed a clean create form only when a MEANINGFULLY different wallet arrives (its `id`
    // changed) — mirroring the original applyWallet path. A same-wallet push (e.g. the container
    // mirroring a limit-save's updated wallet) must NOT wipe a half-typed create form mid-edit.
    const nextId = value?.id ?? null;
    if (value && nextId !== this.lastWalletId) {
      this.resetCreateTransactionForm(false);
    }
    this.lastWalletId = nextId;
  }
  get wallet(): Wallet | null {
    return this._wallet();
  }
  /** RBAC gate: the create composer renders only with transactions.create. */
  @Input() canCreate = false;

  /** Asks the parent to reload the wallet after a successful create (balance changed). */
  @Output() walletShouldReload = new EventEmitter<void>();

  @ViewChild('txCreateFormRef') txCreateForm?: UiFormComponent;
  @ViewChild('txFiltersFormRef') txFiltersForm?: UiFormComponent;

  private readonly _wallet = signal<Wallet | null>(null);
  /** Tracks the last applied wallet id so the create-form reset fires only on a real wallet change. */
  private lastWalletId: string | null = null;
  private txStreamReady = false;
  private readonly destroyRef = inject(DestroyRef);
  private readonly transactionsStore = inject(TransactionsStore);
  /** Operator density preference (F4) applied to the transactions table. */
  protected readonly density = inject(DensityService).density;
  private readonly catalogApi = inject(CatalogApi);
  private readonly transactionsApi = inject(TransactionsApi);
  private readonly toast = inject(ToastService);
  private readonly appError = inject(AppErrorService);
  private readonly i18n = inject(TranslateService);

  readonly creatingTransaction = signal(false);

  readonly txCreateInitialValue = signal<Record<string, unknown>>({
    kind: 'DEPOSIT',
    amount: null,
    description: '',
  });

  readonly txCreateFields: FieldConfig[] = [
    {
      name: 'kind',
      labelKey: 'transactions.create.kind',
      type: 'select',
      options: TX_CREATE_KIND_OPTIONS,
      validators: [Validators.required],
    },
    {
      name: 'amount',
      labelKey: 'transactions.create.amount',
      type: 'number',
      validators: [Validators.required, Validators.min(0.01)],
    },
    {
      name: 'description',
      labelKey: 'transactions.description',
      type: 'text',
      fieldClass: 'wide',
      validators: [Validators.maxLength(255)],
    },
  ];

  readonly txFilterInitialValue = signal<Record<string, unknown>>({});

  readonly txPage = signal(1);
  readonly txPageSize = signal(10);

  readonly txData$ = this.transactionsStore.data$;
  readonly txTotal$ = this.transactionsStore.total$;
  readonly loadingTx$ = this.transactionsStore.loading$;
  readonly showTxSkeleton = signal(true);
  private txLoadStarted = false;

  txColumns: ColumnDef<Transaction>[] = [
    { key: 'createdAt', headerKey: 'transactions.createdAt', type: 'date' },
    {
      key: 'kind',
      headerKey: 'transactions.kind',
      type: 'badge',
      formatter: value => this.i18n.instant(txKindLabelKey(value)),
      badgeColor: value => getTxKindBadgeColor(value),
    },
    {
      key: 'status',
      headerKey: 'transactions.status',
      type: 'badge',
      formatter: value => this.i18n.instant(txStatusLabelKey(value)),
      badgeColor: value => getTxStatusBadgeColor(value),
    },
    { key: 'amount', headerKey: 'transactions.amount', type: 'currency', widthClass: 'w-[170px]' },
    { key: 'description', headerKey: 'transactions.description' },
  ];

  txKindOptions: SelectOption[] = TX_KIND_FILTER_OPTIONS;
  txStatusOptions: SelectOption[] = TX_STATUS_FILTER_OPTIONS;
  // Currency options + the derived filter field list are signals so the async catalog load repaints
  // under OnPush without a manual ChangeDetectorRef.markForCheck (cleaner than the prior cdr path).
  readonly txCurrencyOptions = signal<SelectOption[]>(TX_CURRENCY_FILTER_OPTIONS);
  readonly txFilterFields = signal<FieldConfig[]>(
    this.buildTxFilterFields(TX_CURRENCY_FILTER_OPTIONS),
  );

  constructor() {
    this.loadCurrencyOptions();
    this.txFilterInitialValue.set(this.buildTxFilterInitialValue());

    this.loadingTx$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(loading => {
      if (loading) {
        this.txLoadStarted = true;
        this.showTxSkeleton.set(true);
        return;
      }
      if (this.txLoadStarted) {
        this.showTxSkeleton.set(false);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['customerId'];
    if (change && this.customerId) {
      this.txPage.set(1);
      this.dispatchTransactionsLoad();
    }
  }

  ngAfterViewInit(): void {
    // The filter form lives in this component's template for its whole life (visibility-toggled, not
    // `@if`-gated), so by ngAfterViewInit it always exists — no ViewChild-setter race remains.
    this.setupTxStream();
  }

  createTransaction(): void {
    const form = this.txCreateForm?.form;
    const wallet = this._wallet();
    if (!form || !wallet?.id || this.creatingTransaction()) return;

    form.updateValueAndValidity({ emitEvent: false });
    form.markAllAsTouched();
    if (form.invalid) return;

    const value = form.getRawValue() as {
      kind?: TransactionKind | null;
      amount?: number | string | null;
      description?: string | null;
    };
    const amount = Number(value.amount);
    const amountMinor = majorToMinor(amount);
    if (!Number.isFinite(amount) || amount <= 0 || amountMinor <= 0) return;

    const createdKind: TransactionKind = value.kind ?? 'DEPOSIT';
    const body = this.buildCreateTransactionRequest(
      createdKind,
      wallet,
      amountMinor,
      value.description,
    );

    this.creatingTransaction.set(true);
    this.transactionsApi
      .create(body, randomUuid())
      .pipe(
        tap(() => {
          this.toast.success(this.i18n.instant('transactions.create.created'));
          this.resetCreateTransactionForm();
          this.walletShouldReload.emit();
          this.txPage.set(1);
          // A5: the refetch must be GUARANTEED (never skipped by the filter-form range guard) and
          // the range must actually cover the just-posted record — see reloadAfterCreate.
          this.reloadAfterCreate(createdKind, wallet.currency);
        }),
        catchError(err => {
          this.appError.handleError(err, {
            source: 'CustomerTransactionsComponent',
            operation: 'createTransaction',
          });
          return EMPTY;
        }),
        finalize(() => this.creatingTransaction.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  onTxPageChange(e: { page: number; pageSize: number }): void {
    this.txPage.set(e.page);
    this.txPageSize.set(e.pageSize);
    // The tx stream is reliably wired (the filter form is always present), so a page click reloads
    // server-side through the same MANUAL path as create/clear — the previously dead pager now
    // works. The range guard (C-1) skips a dispatch while a date bound is mid-cleared, exactly as
    // the original `txReload$.pipe(filter(syncTxRangeValidity))` did, so the backend never 400s on a
    // half-range pager click.
    this.manualReload();
  }

  clearTxFilters(): void {
    const defaults = this.buildTxFilterInitialValue();
    if (this.txFiltersForm?.form) {
      this.txFiltersForm.form.reset(defaults, { emitEvent: false });
      this.txFiltersForm.form.markAsPristine();
    } else {
      this.txFilterInitialValue.set(defaults);
    }
    this.txPage.set(1);
    // Reset seeds a valid default range, so the guard passes; routed through the same manual path.
    this.manualReload();
  }

  /**
   * The single MANUAL reload path (pager / clear). Mirrors the original
   * `txReload$.pipe(filter(() => syncTxRangeValidity()))`: a dispatch is skipped while a date bound
   * is mid-cleared (an incomplete range the required-range backend would 400 on), so manual reloads
   * stay range-safe just like the debounced form-changes path (C-1).
   */
  private manualReload(): void {
    if (!this.syncTxRangeValidity()) return;
    this.dispatchTransactionsLoad();
  }

  /**
   * A5 (bugfix-backlog-2026-07): post-create reload with two guarantees the plain manualReload
   * could not give.
   *
   * 1. The dispatch ALWAYS happens. A half-cleared or inverted filter range used to make the
   *    range guard skip the reload silently, so the new row never appeared.
   * 2. The dispatched range actually COVERS the just-posted record. Untouched (pristine) date
   *    bounds still hold the page-load default whose `to` froze at load time — a record created
   *    minutes later fell outside it, which is why the table looked stale until a full page
   *    refresh. Pristine or broken bounds are re-seeded from defaultTxRange() (whose `to` is
   *    ceiled to the next minute); a range the USER typed (dirty controls) is preserved.
   *
   * UX decision (documented): user-set filters are NOT reset after a create — operators filter
   * deliberately mid-investigation. If the active filters would hide the new record (kind /
   * currency / status mismatch, or a past `to` bound) an informational toast explains it.
   */
  private reloadAfterCreate(createdKind: TransactionKind, createdCurrency: string): void {
    this.refreshTxRangeForCreate();
    this.dispatchTransactionsLoad();
    if (this.createdTxHiddenByFilters(createdKind, createdCurrency)) {
      this.toast.info(this.i18n.instant('transactions.create.filteredOut'));
    }
  }

  /** Re-seeds the filter date bounds unless the user set a complete, valid range themselves. */
  private refreshTxRangeForCreate(): void {
    const form = this.txFiltersForm?.form;
    if (!form) return;
    const fromCtrl = form.get('from') as FormControl | null;
    const toCtrl = form.get('to') as FormControl | null;
    if (!fromCtrl || !toCtrl) return;

    const userTouchedRange = fromCtrl.dirty || toCtrl.dirty;
    if (userTouchedRange && this.syncTxRangeValidity()) return;

    // setValue on validator-less controls recomputes validity, clearing any lingering `range` error.
    const range = this.defaultTxRange();
    fromCtrl.setValue(range.from, { emitEvent: false });
    toCtrl.setValue(range.to, { emitEvent: false });
  }

  /** True when the ACTIVE filter values would exclude the transaction that was just created. */
  private createdTxHiddenByFilters(createdKind: TransactionKind, createdCurrency: string): boolean {
    const form = this.txFiltersForm?.form;
    if (!form) return false;
    const v = form.getRawValue() as {
      kind?: string;
      status?: string;
      currency?: string;
      from?: string;
      to?: string;
    };
    if (v.kind && v.kind !== createdKind) return true;
    // An operator-created transaction posts immediately (TransactionSnapshot.status === 'POSTED').
    if (v.status && v.status !== 'POSTED') return true;
    if (v.currency && v.currency !== createdCurrency) return true;
    const now = Date.now();
    const from = v.from ? new Date(v.from).getTime() : NaN;
    const to = v.to ? new Date(v.to).getTime() : NaN;
    if (!isNaN(from) && from > now) return true;
    if (!isNaN(to) && to < now) return true;
    return false;
  }

  private buildTxFilterFields(currencyOptions: SelectOption[]): FieldConfig[] {
    return [
      { name: 'kind', labelKey: 'transactions.kind', type: 'select', options: this.txKindOptions },
      {
        name: 'status',
        labelKey: 'transactions.status',
        type: 'select',
        options: this.txStatusOptions,
      },
      {
        name: 'currency',
        labelKey: 'transactions.currency',
        type: 'select',
        options: currencyOptions,
      },
      { name: 'from', labelKey: 'transactions.from', type: 'datetime-local' },
      { name: 'to', labelKey: 'transactions.to', type: 'datetime-local', fieldClass: 'wide' },
    ];
  }

  private loadCurrencyOptions(): void {
    this.catalogApi
      .listCurrencies()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(currencies => {
        const options: SelectOption[] = [
          TX_CURRENCY_FILTER_OPTIONS[0],
          ...currencies.map(currency => ({ labelKey: currency.code, value: currency.code })),
        ];
        this.txCurrencyOptions.set(options);
        this.txFilterFields.set(this.buildTxFilterFields(options));
      });
  }

  private setupTxStream(): void {
    // Idempotent: wired exactly once. Without this guard the stream would be subscribed twice.
    // INVARIANT: this subscribes to the SAME FormGroup instance for the component's life. ui-form
    // rebuilds its FormGroup only when field NAMES change (buildControlSignature); the async catalog
    // load swaps `currency` OPTIONS, not names, so `form` here survives the options rebind and the
    // valueChanges subscription stays live. If a filter field is ever renamed/added/removed, ui-form
    // would mint a new FormGroup and this stream would need re-wiring.
    const form = this.txFiltersForm?.form;
    if (!form || this.txStreamReady) return;
    this.txStreamReady = true;

    const formChanges$ = form.valueChanges.pipe(
      debounceTime(250),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      tap(() => this.txPage.set(1)),
      filter(() => this.syncTxRangeValidity()),
    );

    formChanges$
      .pipe(
        tap(() => this.dispatchTransactionsLoad()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private syncTxRangeValidity(): boolean {
    const form = this.txFiltersForm?.form;
    if (!form) return true;

    const fromCtrl = form.get('from') as FormControl | null;
    const toCtrl = form.get('to') as FormControl | null;
    if (!fromCtrl || !toCtrl) return true;

    const from = fromCtrl.value as string;
    const to = toCtrl.value as string;

    const clearRange = (ctrl: FormControl) => {
      if (!ctrl.errors || !ctrl.errors['range']) return;
      const { range, ...rest } = ctrl.errors as Record<string, unknown>;
      this.setRemainingErrors(ctrl, rest);
    };

    // The backend date range is REQUIRED (transactions.api.ts), so a no-date request 400s
    // (audit fn-tx-daterange-400). When BOTH inputs are manually cleared, re-seed
    // the 12-month default so a valid range is always dispatched instead of an empty one.
    if (!from && !to) {
      const range = this.defaultTxRange();
      // setValue (no validators on these controls) recomputes validity, which also clears any
      // lingering `range` error — so a valid, complete range is dispatched.
      fromCtrl.setValue(range.from, { emitEvent: false });
      toCtrl.setValue(range.to, { emitEvent: false });
      return true;
    }

    // Exactly one bound is blank: an incomplete range the backend would reject — block the dispatch
    // (the user is mid-edit) rather than send a half-range.
    if (!from || !to) {
      return false;
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      clearRange(fromCtrl);
      clearRange(toCtrl);
      return true;
    }

    const isValid = fromDate.getTime() <= toDate.getTime();
    if (!isValid) {
      fromCtrl.setErrors({ ...(fromCtrl.errors ?? {}), range: true });
      toCtrl.setErrors({ ...(toCtrl.errors ?? {}), range: true });
      return false;
    }

    clearRange(fromCtrl);
    clearRange(toCtrl);
    return true;
  }

  private setRemainingErrors(control: FormControl | null, errors: Record<string, unknown>): void {
    if (Object.keys(errors).length) {
      control?.setErrors(errors);
      return;
    }
    control?.setErrors(null);
  }

  private resetCreateTransactionForm(markClean = true): void {
    const value = this.buildTxCreateInitialValue();
    this.txCreateInitialValue.set(value);
    const form = this.txCreateForm?.form;
    if (!form) return;
    form.reset(value, { emitEvent: false });
    if (markClean) {
      form.markAsPristine();
      form.markAsUntouched();
    }
    form.updateValueAndValidity({ emitEvent: false });
  }

  private buildTxCreateInitialValue(): Record<string, unknown> {
    return {
      kind: 'DEPOSIT',
      amount: null,
      description: '',
    };
  }

  private buildCreateTransactionRequest(
    kind: TransactionKind,
    wallet: Wallet,
    amountMinor: number,
    description?: string | null,
  ): CreateTransactionRequest {
    const cleanDescription = description?.trim() || undefined;
    const base = {
      kind,
      amountMinor,
      currency: wallet.currency,
      description: cleanDescription,
    };
    if (kind === 'DEPOSIT') {
      return { ...base, targetWalletId: wallet.id };
    }
    return { ...base, sourceWalletId: wallet.id };
  }

  private buildTxFilterInitialValue() {
    const range = this.defaultTxRange();
    return {
      kind: '',
      status: '',
      currency: '',
      from: range.from,
      to: range.to,
    };
  }

  private defaultTxRange() {
    const now = new Date();
    const from = new Date(now);
    // 364 days — just under the backend's 366-day hard bound. A plain 12-calendar-month default could
    // span 366 days across a leap boundary and 400 on the very first load (audit D7).
    from.setDate(from.getDate() - 364);
    // `to` is CEILED to the next minute: toDateTimeLocal truncates seconds, so a floor-to-minute
    // bound excluded records posted later within the same minute (and small server-clock skew) —
    // part of the A5 "new row missing until refresh" bug. The backend accepts a future `to`.
    const to = new Date(now);
    to.setSeconds(0, 0);
    to.setMinutes(to.getMinutes() + 1);
    return {
      from: this.toDateTimeLocal(from),
      to: this.toDateTimeLocal(to),
    };
  }

  private toDateTimeLocal(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  private dispatchTransactionsLoad(): void {
    // D-13 FE: the filter values are narrowed to the real ledger enums so the params
    // are enum-checked instead of the prior `as any` casts. Empty-string ⇒ "no filter" ⇒ undefined.
    const v = (this.txFiltersForm?.form?.getRawValue() ?? this.txFilterInitialValue()) as {
      kind?: string;
      status?: string;
      currency?: string;
      from?: string;
      to?: string;
    } | null;

    const filters: Partial<{ kind: TransactionKind; status: TransactionStatus }> = {
      kind: (v?.kind || undefined) as TransactionKind | undefined,
      status: (v?.status || undefined) as TransactionStatus | undefined,
    };

    const params: ListTransactionsParams = {
      page: this.txPage(),
      pageSize: this.txPageSize(),
      kind: filters.kind,
      status: filters.status,
      currency: (v?.currency ?? '') || undefined,
      from: (v?.from ?? '') || undefined,
      to: (v?.to ?? '') || undefined,
    };

    this.transactionsStore.load(this.customerId, params);
  }
}

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const n = Math.floor(Math.random() * 16);
    const v = char === 'x' ? n : (n & 0x3) | 0x8;
    return v.toString(16);
  });
}
