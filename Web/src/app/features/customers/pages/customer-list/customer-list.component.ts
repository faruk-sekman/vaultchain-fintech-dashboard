/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnDestroy,
  OnInit,
  TemplateRef,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subject, combineLatest, debounceTime, distinctUntilChanged } from 'rxjs';
import { filter, map, takeUntil } from 'rxjs/operators';

import { AuthService } from '@core/auth/auth.service';
import { DensityService } from '@core/services/density.service';
import { Customer, KycStatus } from '@shared/models/customer.model';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import { UiSelectComponent } from '@shared/components/ui-select/ui-select.component';
import { UiTableComponent } from '@shared/components/ui-table/ui-table.component';
import { UiTabsComponent, UiTabItem } from '@shared/components/ui-tabs/ui-tabs.component';
import { CellTemplateContext, ColumnDef } from '@shared/components/ui-table/ui-table.types';
import { UiAvatarComponent } from '@shared/components/ui-avatar/ui-avatar.component';
import { SelectOption } from '@shared/components/ui-form/ui-form.types';
import {
  getKycStatusBadgeColor,
  kycLabelKey,
  KYC_STATUS_FILTER_OPTIONS,
} from '@shared/utils/kyc-status';
import { CustomersStore } from '@features/customers/state';
// A3: consume the existing self-healing SSE stream. NOTE feature→feature import —
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';
import { UiDrawerComponent } from '@shared/components/ui-drawer/ui-drawer.component';
import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';
import { HasPermissionDirective } from '@shared/directives/has-permission.directive';

/** Page density (§4.5) — comfortable (default) or compact. Persisted globally via DensityService. */
export type CustomerListDensity = 'comfortable' | 'compact';

/** A removable active-filter token (§7.3 / §8 Filtering). */
export interface ActiveFilterChip {
  /** Which control the chip clears when removed. */
  key: 'search' | 'kycStatus' | 'isActive';
  /** Already-translated chip text. */
  label: string;
  /** Already-translated accessible name for the remove button, including the subject. */
  removeAria: string;
}

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiTableComponent,
    UiTabsComponent,
    UiInputComponent,
    UiSelectComponent,
    UiButtonComponent,
    UiConfirmDialogComponent,
    UiEmptyComponent,
    UiDrawerComponent,
    UiSegmentedComponent,
    UiAvatarComponent,
    HasPermissionDirective,
  ],
  templateUrl: './customer-list.component.html',
  styleUrl: './customer-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerListComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();
  private readonly deleteTarget$ = new BehaviorSubject<Customer | null>(null);

  search = new FormControl<string>('', { nonNullable: true });
  kycStatus = new FormControl<string>('', { nonNullable: true });
  isActive = new FormControl<string>('', { nonNullable: true });

  page = 1;
  pageSize = 10;

  /**
   * Admin-only PII reveal view-state — holds ONLY the boolean, never PII.
   * Default masked; request-only (NOT persisted to the route query). Rides on `ListCustomersParams.reveal`
   * so a toggle re-fires `load()` with the current filter/page, and SSE-driven reloads carry it too.
   */
  protected readonly reveal = signal(false);

  deleteModalOpen = false;
  deleteTarget: Customer | null = null;

  /** Toolbar density (§4.5); delegates to the global, persisted preference (Settings ↔ list stay in sync). */
  get density(): CustomerListDensity {
    return this.densityService.density();
  }

  /** Mobile-only Filters drawer (§7.3 responsive — filters collapse into a drawer below md). */
  filtersDrawerOpen = false;

  /**
   * Density segments (§5.18). Icon-only, so each carries a pre-translated `ariaLabel` (the
   * segmented control treats `ariaLabel` as already-translated). Computed via a getter so labels
   * resolve after translations load (and re-resolve on language switch).
   */
  get densityOptions(): UiSegmentItem[] {
    return [
      {
        value: 'comfortable',
        icon: 'ri-expand-height-line',
        ariaLabel: this.i18n.instant('common.comfortable'),
      },
      {
        value: 'compact',
        icon: 'ri-contract-up-down-line',
        ariaLabel: this.i18n.instant('common.compact'),
      },
    ];
  }

  columns: ColumnDef<Customer>[] = [
    // First column renders avatar + name + email (see customerCellTemplate); no separate email
    // column — the standalone one duplicated the value already shown under the name (audit dedup).
    { key: 'name', headerKey: 'customers.name' },
    { key: 'phone', headerKey: 'customers.phone' },
    { key: 'walletNumber', headerKey: 'customers.walletNumber', widthClass: 'w-[170px]' },
    { key: 'nationalId', headerKey: 'customers.nationalId', widthClass: 'w-[150px]' },
    {
      key: 'kycStatus',
      headerKey: 'customers.kycStatus',
      type: 'badge',
      widthClass: 'w-[140px]',
      formatter: value => this.i18n.instant(kycLabelKey(value)),
      badgeColor: value => getKycStatusBadgeColor(value),
    },
    {
      // Read-only status indicator (NOT an interactive toggle): a static `app-ui-badge` mirroring
      // the kycStatus column. Activating/deactivating a customer happens on the edit form, not here,
      // so the previous `type:'toggle'` switch was a misleading, non-keyboard/AT-usable fake control.
      // Never colour-only — the icon distinguishes Aktif vs Pasif without relying on hue (a11y).
      key: 'isActive',
      headerKey: 'customers.active',
      type: 'badge',
      widthClass: 'w-[120px]',
      formatter: value => this.i18n.instant(value ? 'customers.active' : 'customers.inactive'),
      badgeColor: value => (value ? 'green' : 'zinc'),
      badgeIcon: value => (value ? 'ri-checkbox-circle-line' : 'ri-pause-circle-line'),
    },
  ];

  /**
   * Custom renderer for the first ("name") column — avatar + name + email stacked (§7.3).
   * Attached to `columns[0].cellTemplate` in `ngAfterViewInit` (when the view template
   * resolves); the table falls back to its default text rendering until then and in any
   * context where the view is never initialised (e.g. the manual-`new` unit spec).
   */
  @ViewChild('customerCell', { read: TemplateRef })
  customerCellTemplate?: TemplateRef<CellTemplateContext<Customer>>;

  kycStatusOptions: SelectOption[] = KYC_STATUS_FILTER_OPTIONS;

  /**
   * v2 §5 status filter tabs (All / Active / Inactive). They write to the SAME
   * `isActive` control the old select used, so the query-param → store flow,
   * chips and clear-all behaviour are unchanged.
   */
  readonly statusTabs: ReadonlyArray<UiTabItem> = [
    { value: '', labelKey: 'common.all' },
    { value: 'true', labelKey: 'customers.active' },
    { value: 'false', labelKey: 'customers.inactive' },
  ];

  private readonly customersStore = inject(CustomersStore);
  /** Realtime SSE source (A3); `providedIn:'root'`, stubbed in specs (mirrors the dashboard). */
  private readonly stream = inject(DashboardStreamService);
  private readonly densityService = inject(DensityService);
  /** Defense-in-depth RBAC gate; reads the principal via a computed so OnPush re-evaluates. */
  protected readonly auth = inject(AuthService);
  /**
   * OnPush: `page`, `deleteModalOpen` and `deleteTarget` are plain fields mutated from
   * RxJS subscriptions (queryParamMap / deleteSuccess$), not template events — so re-render must be
   * marked explicitly. Injected via `inject()` to keep the 3-arg constructor stable; `optional` so the
   * existing manual-`new` spec (no view-node injector) still constructs the component.
   */
  private readonly cdr = inject(ChangeDetectorRef, { optional: true });
  data$ = this.customersStore.data$;
  loading$ = this.customersStore.loading$;
  total$ = this.customersStore.total$;
  /** Inline error/retry region source; truthy after a failed list load. */
  error$ = this.customersStore.error$;
  deleting$ = this.customersStore.deleting$;
  deletingId$ = this.customersStore.deletingId$;
  deletingTarget$ = combineLatest([this.deleting$, this.deletingId$, this.deleteTarget$]).pipe(
    map(([deleting, deletingId, target]) => !!target && deleting && deletingId === target.id),
  );

  constructor(
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly i18n: TranslateService,
  ) {}

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const kyc = params.get('kycStatus') ?? '';
      const active = params.get('isActive') ?? '';
      const page = Number(params.get('page')) || 1;

      this.kycStatus.setValue(kyc, { emitEvent: false });
      this.isActive.setValue(active, { emitEvent: false });
      this.page = Math.max(1, page);

      this.load();
      // Backward-compatible cleanup for old shared URLs: a free-text customer query can contain a
      // name, email, phone, wallet number or national ID, so it must never persist in browser history.
      if (params.has('search')) this.updateQueryParams({ page: this.page });
      // OnPush: `page` is bound to the table/pagination but was mutated outside a template event.
      this.cdr?.markForCheck();
    });

    this.search.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(() => {
        this.page = 1;
        this.updateQueryParams({ page: 1 });
        this.load();
      });

    this.kycStatus.valueChanges
      .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(value => this.updateQueryParams({ kycStatus: value, page: 1 }));

    this.isActive.valueChanges
      .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe(value => this.updateQueryParams({ isActive: value, page: 1 }));

    this.customersStore.deleteSuccess$
      .pipe(
        filter(({ id }) => !!this.deleteTarget && this.deleteTarget.id === id),
        takeUntil(this.destroy$),
      )
      .subscribe(() => {
        // A4: the list reload now rides the store's deleteCustomerSuccess→loadCustomers effect
        // (with the tracked current-view params) — the component only closes its dialog.
        this.closeDelete();
        // OnPush: closing the dialog flips `deleteModalOpen` from a subscription, not a template event.
        this.cdr?.markForCheck();
      });

    // Realtime (SSE, A3): a customer mutation by ANY operator/process pushes a
    // PII-free signal; re-`load()` with the CURRENT filter/page so the list + its total stay live
    // (the active view is preserved). Debounced to coalesce bursts; idempotent (an own-delete that
    // already reloaded via `deleteSuccess$` double-reloads harmlessly). Torn down with `destroy$`
    // (mirrors the teardown above); the service self-heals reconnects.
    this.stream
      .connect()
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe(() => this.load());
  }

  ngAfterViewInit(): void {
    // Attach the avatar+name+email renderer to the first column once its template exists.
    // A fresh `columns` array reference makes the OnPush table pick up the new cellTemplate
    // deterministically; column order and every other definition are preserved.
    if (this.customerCellTemplate && this.columns[0] && !this.columns[0].cellTemplate) {
      this.columns = this.columns.map((col, index) =>
        index === 0 ? { ...col, cellTemplate: this.customerCellTemplate } : col,
      );
      this.cdr?.markForCheck();
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  create() {
    this.router.navigate(['/customers/new']);
  }

  /**
   * Admin-only: flip PII reveal and re-load the CURRENT filter/page. No local
   * unmask — the re-fetch asks the server, which is the authority; toggling OFF re-loads masked so no prior
   * unmasked row is retained. Request-only (not written to the route query). Carries only the boolean state.
   */
  toggleReveal(): void {
    this.reveal.update(v => !v);
    this.load();
  }

  openDelete(row: Customer) {
    this.deleteTarget = row;
    this.deleteTarget$.next(row);
    this.deleteModalOpen = true;
  }

  closeDelete() {
    this.deleteModalOpen = false;
    this.deleteTarget = null;
    this.deleteTarget$.next(null);
  }

  confirmDelete() {
    if (!this.deleteTarget) return;
    this.customersStore.delete(this.deleteTarget.id);
  }

  onPageChange(e: { page: number; pageSize: number }) {
    this.page = e.page;
    this.pageSize = e.pageSize;
    this.updateQueryParams({ page: e.page });
  }

  open(row: Customer) {
    this.router.navigate(['/customers', row.id]);
  }

  clearFilters() {
    this.search.setValue('', { emitEvent: false });
    this.page = 1;
    this.updateQueryParams({ kycStatus: '', isActive: '', page: 1 });
    this.load();
  }

  get hasActiveFilters(): boolean {
    return !!(this.search.value || this.kycStatus.value || this.isActive.value);
  }

  /** Count of active filters — drives the toolbar Filters button badge on mobile. */
  get activeFilterCount(): number {
    return this.activeFilterChips.length;
  }

  /**
   * Active filters as removable chips (§8 Filtering). Built from the current control values so it
   * stays in lockstep with the existing filter state; removing a chip clears just that control,
   * which feeds the unchanged `valueChanges` → `updateQueryParams` flow.
   */
  get activeFilterChips(): ActiveFilterChip[] {
    const chips: ActiveFilterChip[] = [];

    if (this.search.value) {
      chips.push(this.buildChip('search', this.search.value));
    }
    if (this.kycStatus.value) {
      chips.push(this.buildChip('kycStatus', this.i18n.instant(kycLabelKey(this.kycStatus.value))));
    }
    if (this.isActive.value) {
      const labelKey = this.isActive.value === 'true' ? 'common.yes' : 'common.no';
      chips.push(this.buildChip('isActive', this.i18n.instant(labelKey)));
    }

    return chips;
  }

  /**
   * Status tab → the EXISTING `isActive` control (same store filter as before).
   * `valueChanges` then resets the page and syncs the query params, exactly like
   * the retired select did.
   */
  onStatusTabChange(value: string): void {
    if (value !== '' && value !== 'true' && value !== 'false') return;
    this.isActive.setValue(value);
  }

  /** Clears a single active filter; the control's `valueChanges` resets the page and reloads. */
  removeFilter(key: ActiveFilterChip['key']): void {
    switch (key) {
      case 'search':
        this.search.setValue('');
        break;
      case 'kycStatus':
        this.kycStatus.setValue('');
        break;
      case 'isActive':
        this.isActive.setValue('');
        break;
    }
  }

  setDensity(density: string): void {
    if (density !== 'comfortable' && density !== 'compact') return;
    this.densityService.setDensity(density);
  }

  /** Re-fire the list load with the current filter/page (the inline error-region retry). */
  reload(): void {
    this.load();
  }

  openFiltersDrawer(): void {
    this.filtersDrawerOpen = true;
  }

  closeFiltersDrawer(): void {
    this.filtersDrawerOpen = false;
  }

  private buildChip(key: ActiveFilterChip['key'], label: string): ActiveFilterChip {
    return {
      key,
      label,
      removeAria: this.i18n.instant('common.remove', { item: label }),
    };
  }

  private load() {
    const status = (this.kycStatus.value || undefined) as KycStatus | undefined;
    const active = this.activeFilterValue();

    this.customersStore.load({
      page: this.page,
      pageSize: this.pageSize,
      search: this.search.value || undefined,
      kycStatus: status,
      isActive: active,
      // Reveal rides the same params: the wire asks for unmasked PII only when ON; the server is the
      // authority (fail-closed to masked otherwise). The store effect's switchMap gives last-write-wins.
      reveal: this.reveal() || undefined,
    });
  }

  private updateQueryParams(params: { kycStatus?: string; isActive?: string; page?: number }) {
    const nextKyc = params.kycStatus ?? this.kycStatus.value;
    const nextActive = params.isActive ?? this.isActive.value;
    const nextPage = params.page ?? this.page;

    this.router.navigate([], {
      relativeTo: this.route,
      // No `queryParamsHandling: 'merge'`: this list owns the full query string and recomputes ALL
      // non-sensitive params (kycStatus/isActive/page) on every call, so a fresh replace is correct.
      // Free-text search deliberately stays component-local because it can contain customer PII.
      // Merging used to carry a foreign `?section=` over from Settings (e.g. /customers?section=access),
      // leaking unrelated state onto the URL. A plain navigate preserves only the list's own params.
      queryParams: {
        kycStatus: this.blankToNull(nextKyc),
        isActive: this.blankToNull(nextActive),
        page: this.pageQueryValue(nextPage),
      },
      replaceUrl: true,
    });
  }

  private activeFilterValue(): boolean | undefined {
    if (this.isActive.value === '') return undefined;
    return this.isActive.value === 'true';
  }

  private blankToNull(value: string): string | null {
    if (value) return value;
    return null;
  }

  private pageQueryValue(page: number): number | null {
    if (page && page > 1) return page;
    return null;
  }
}
