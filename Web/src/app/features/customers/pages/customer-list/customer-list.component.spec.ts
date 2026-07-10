/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { convertToParamMap } from '@angular/router';
import { CustomerListComponent } from './customer-list.component';
import { CustomersStore } from '@features/customers/state';
import { AuthService } from '@core/auth/auth.service';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { DashboardEvent } from '@core/api/dashboard.api';

/** Stub AuthService whose granted permission set is controllable per test. */
function authMock(granted: string[] = ['customers.manage']) {
  return { hasPermission: (p: string) => granted.includes(p) } as unknown as AuthService;
}

/**
 * Stub DashboardStreamService (A3). `connect()` returns a Subject so a test can emit
 * an SSE event; the default never emits, so the realtime subscription is a no-op for every other
 * test. Always provided because the real service is `providedIn:'root'` (its DI chain — DashboardApi
 * → ApiClientService — is not satisfied in this lean TestBed), mirroring the dashboard spec.
 */
function streamMock(events$: Subject<DashboardEvent> = new Subject<DashboardEvent>()) {
  return { connect: vi.fn(() => events$) } as unknown as DashboardStreamService;
}

const customer = {
  id: '1',
  name: 'A',
  email: '',
  phone: '',
  walletNumber: '',
  nationalId: 0,
  dateOfBirth: '',
  address: { country: '', city: '', postalCode: '', line1: '' },
  kycStatus: 'UNKNOWN',
  isActive: true,
  createdAt: '',
  updatedAt: '',
} as any;

describe('CustomerListComponent', () => {
  const query$ = new BehaviorSubject(convertToParamMap({}));
  const deleteSuccess$ = new Subject<{ id: string }>();
  const storeMock = {
    data$: of([customer]),
    loading$: of(false),
    total$: of(1),
    error$: of(null),
    deleting$: of(false),
    deletingId$: of(null),
    deleteSuccess$,
    load: vi.fn(),
    delete: vi.fn(),
  };
  const routerMock = { navigate: vi.fn() };
  const routeMock = { queryParamMap: query$ };
  const i18nMock = { instant: (k: string) => k };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock() },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });
  });

  it('loads customers based on query params', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.ngOnInit();

    query$.next(convertToParamMap({ search: 'john', page: '2', isActive: 'true' }));
    expect(storeMock.load).toHaveBeenCalled();
    expect(component.page).toBe(2);
  });

  it('open/close delete modal and confirm deletion', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    component.openDelete(customer);
    expect(component.deleteModalOpen).toBe(true);
    component.confirmDelete();
    expect(storeMock.delete).toHaveBeenCalledWith('1');

    component.closeDelete();
    expect(component.deleteModalOpen).toBe(false);
    expect(component.deleteTarget).toBeNull();
  });

  it('confirmDelete is a no-op when no row is pending deletion', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    component.confirmDelete();

    expect(storeMock.delete).not.toHaveBeenCalled();
  });

  it('updates query params on page change and clear filters', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    component.onPageChange({ page: 3, pageSize: 10 });
    expect(routerMock.navigate).toHaveBeenCalled();

    component.clearFilters();
    expect(routerMock.navigate).toHaveBeenCalled();
  });

  it('uses the current controls/page when updateQueryParams is called with sparse params', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.search.setValue('Ada', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.isActive.setValue('false', { emitEvent: false });
    component.page = 4;
    routerMock.navigate.mockClear();

    (
      component as unknown as {
        updateQueryParams(params: {
          search?: string;
          kycStatus?: string;
          isActive?: string;
          page?: number;
        }): void;
      }
    ).updateQueryParams({});

    expect(routerMock.navigate).toHaveBeenCalledWith([], {
      relativeTo: routeMock,
      queryParams: {
        search: 'Ada',
        kycStatus: 'VERIFIED',
        isActive: 'false',
        page: 4,
      },
      replaceUrl: true,
    });
  });

  it('navigates to create and detail', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.create();
    component.open(customer);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/customers/new']);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/customers', '1']);
  });

  it('exposes the v2 status tabs mapped onto the EXISTING isActive filter values', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    expect(component.statusTabs.map(t => t.value)).toEqual(['', 'true', 'false']);
    expect(component.statusTabs.map(t => t.labelKey)).toEqual([
      'common.all',
      'customers.active',
      'customers.inactive',
    ]);
  });

  it('onStatusTabChange writes the same isActive control the old select used (guarded)', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.ngOnInit();

    component.onStatusTabChange('true');
    expect(component.isActive.value).toBe('true');
    // The unchanged valueChanges flow resets the page + syncs the query params.
    expect(routerMock.navigate).toHaveBeenCalled();

    // Unknown tab values never reach the store filter.
    component.onStatusTabChange('nonsense');
    expect(component.isActive.value).toBe('true');

    component.onStatusTabChange('');
    expect(component.isActive.value).toBe('');
    component.ngOnDestroy();
  });

  it('computes hasActiveFilters', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    expect(component.hasActiveFilters).toBe(false);
    component.search.setValue('x');
    expect(component.hasActiveFilters).toBe(true);
  });

  it('closes delete modal on delete success', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.ngOnInit();
    component.openDelete(customer);

    deleteSuccess$.next({ id: '1' });
    expect(component.deleteModalOpen).toBe(false);
  });

  it('updates query params from filter controls and cleans up', () => {
    vi.useFakeTimers();
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.ngOnInit();

    component.search.setValue('abc');
    vi.advanceTimersByTime(400);
    component.kycStatus.setValue('VERIFIED');
    component.isActive.setValue('true');
    expect(routerMock.navigate).toHaveBeenCalled();

    component.ngOnDestroy();
    vi.useRealTimers();
  });

  it('navigates without merging foreign query params while preserving its own (no ?section leak)', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    // The list owns these params; a foreign `section` (carried from Settings) must NOT survive.
    component.search.setValue('Elif', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.isActive.setValue('true', { emitEvent: false });
    component.page = 2;
    routerMock.navigate.mockClear();

    component.onPageChange({ page: 2, pageSize: 10 });

    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    const [commands, extras] = routerMock.navigate.mock.calls[0];
    expect(commands).toEqual([]);
    // The fix: no merge handling, so a stale `?section=access` cannot be preserved.
    expect(extras.queryParamsHandling).toBeUndefined();
    expect(extras.replaceUrl).toBe(true);
    // Its OWN params are still recomputed and present on every navigation.
    expect(extras.queryParams).toEqual({
      search: 'Elif',
      kycStatus: 'VERIFIED',
      isActive: 'true',
      page: 2,
    });
    // And it never re-emits a `section` key (foreign params are simply dropped).
    expect('section' in extras.queryParams).toBe(false);
  });

  it('renders the active status as an accessible read-only badge (Aktif/Pasif label + variant + icon, not a switch)', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    const statusCol = component.columns[5];
    // Read-only status indicator: a badge, never the misleading interactive `toggle` switch.
    expect(statusCol.key).toBe('isActive');
    expect(statusCol.type).toBe('badge');

    // Label reuses the existing All/Active/Passive tab keys (i18nMock echoes the key). No Yes/No.
    const activeRow = { ...customer, isActive: true } as any;
    const passiveRow = { ...customer, isActive: false } as any;
    expect(statusCol.formatter?.(true as any, activeRow)).toBe('customers.active');
    expect(statusCol.formatter?.(false as any, passiveRow)).toBe('customers.inactive');

    // Distinguishable without colour: success/green + neutral/muted variant AND a distinct icon (a11y).
    const color = statusCol.badgeColor;
    const icon = statusCol.badgeIcon;
    expect(typeof color).toBe('function');
    expect(typeof icon).toBe('function');
    if (typeof color === 'function') {
      expect(color(true as any, activeRow)).toBe('green');
      expect(color(false as any, passiveRow)).toBe('zinc');
    }
    if (typeof icon === 'function') {
      const activeIcon = icon(true as any, activeRow);
      const passiveIcon = icon(false as any, passiveRow);
      expect(activeIcon).toBeTruthy();
      expect(passiveIcon).toBeTruthy();
      expect(activeIcon).not.toBe(passiveIcon);
    }
  });

  it('exposes localized density controls and KYC badge helpers', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    expect(component.densityOptions.map(option => option.ariaLabel)).toEqual([
      'common.comfortable',
      'common.compact',
    ]);
    const kycCol = component.columns[4];
    expect(kycCol.formatter?.('VERIFIED' as any, customer)).toBe('kyc.VERIFIED');
    expect(kycCol.badgeColor?.('VERIFIED' as any, customer)).toBe('green');
  });

  it('evaluates deletingTarget$', () => {
    const deleting$ = new BehaviorSubject(false);
    const deletingId$ = new BehaviorSubject<string | null>(null);
    const deleteSuccess$Local = new Subject<{ id: string }>();
    const store = {
      data$: of([customer]),
      loading$: of(false),
      total$: of(1),
      error$: of(null),
      deleting$,
      deletingId$,
      deleteSuccess$: deleteSuccess$Local,
      load: vi.fn(),
      delete: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: store },
        { provide: AuthService, useValue: authMock() },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    const results: boolean[] = [];
    const sub = component.deletingTarget$.subscribe(value => results.push(value));
    component.openDelete(customer);
    deleting$.next(true);
    deletingId$.next('1');
    expect(results.at(-1)).toBe(true);
    sub.unsubscribe();
  });

  it('derives removable active-filter chips from the current controls', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    expect(component.activeFilterChips).toEqual([]);
    expect(component.activeFilterCount).toBe(0);

    component.search.setValue('john', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.isActive.setValue('true', { emitEvent: false });

    const chips = component.activeFilterChips;
    expect(chips.map(c => c.key)).toEqual(['search', 'kycStatus', 'isActive']);
    expect(component.activeFilterCount).toBe(3);
    // i18nMock.instant echoes the key, so the KYC chip label is the resolved kyc.* key.
    expect(chips[1].label).toBe('kyc.VERIFIED');
    expect(chips[0].removeAria).toBe('common.remove');

    component.isActive.setValue('false', { emitEvent: false });
    expect(component.activeFilterChips.find(c => c.key === 'isActive')?.label).toBe('common.no');
  });

  it('removeFilter clears only the targeted control', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.search.setValue('john', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.isActive.setValue('false', { emitEvent: false });

    component.removeFilter('search');
    expect(component.search.value).toBe('');
    expect(component.kycStatus.value).toBe('VERIFIED');
    expect(component.isActive.value).toBe('false');

    component.removeFilter('kycStatus');
    expect(component.kycStatus.value).toBe('');
    expect(component.isActive.value).toBe('false');

    component.removeFilter('isActive');
    expect(component.isActive.value).toBe('');
  });

  it('setDensity validates, applies and persists; opens/closes the filters drawer', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    component.setDensity('nonsense' as any);
    expect(component.density).toBe('comfortable');

    component.setDensity('compact');
    expect(component.density).toBe('compact');
    // Density now persists through the global DensityService (Settings ↔ list share one preference).
    expect(setItem).toHaveBeenCalledWith('density', 'compact');

    component.openFiltersDrawer();
    expect(component.filtersDrawerOpen).toBe(true);
    component.closeFiltersDrawer();
    expect(component.filtersDrawerOpen).toBe(false);
    setItem.mockRestore();
  });

  it('ngAfterViewInit attaches the customer cell template to the first column once, additively', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );

    // Snapshot index-sensitive columns the table contract relies on (kyc badge / active status badge).
    const before = component.columns;
    const kycBadgeColor = before[4].badgeColor;
    const activeFormatter = before[5].formatter;
    const activeBadgeIcon = before[5].badgeIcon;
    expect(before[0].cellTemplate).toBeUndefined();

    // Before the view resolves the @ViewChild template, ngAfterViewInit is a no-op.
    component.ngAfterViewInit();
    expect(component.columns).toBe(before);
    expect(component.columns[0].cellTemplate).toBeUndefined();

    // With the template present it attaches to columns[0] only; order/indices are preserved.
    const tpl = {} as any;
    component.customerCellTemplate = tpl;
    component.ngAfterViewInit();
    expect(component.columns[0].cellTemplate).toBe(tpl);
    expect(component.columns[1].cellTemplate).toBeUndefined();
    // Indices after the standalone email column was removed: kyc=[4], active=[5].
    expect(component.columns[4].badgeColor).toBe(kycBadgeColor);
    expect(component.columns[5].formatter).toBe(activeFormatter);
    expect(component.columns[5].badgeIcon).toBe(activeBadgeIcon);

    // Idempotent: a second pass does not rebuild the array (already attached).
    const attached = component.columns;
    component.ngAfterViewInit();
    expect(component.columns).toBe(attached);
  });

  it('exposes the store error stream for the inline retry region', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    expect(component.error$).toBe(storeMock.error$);
  });

  it('reload() re-fires the list load with the current filter + page (the retry button)', () => {
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    // Simulate a failed load that left a search filter and page 3 in place.
    component.search.setValue('jane', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.page = 3;
    storeMock.load.mockClear();

    component.reload();

    expect(storeMock.load).toHaveBeenCalledTimes(1);
    expect(storeMock.load).toHaveBeenCalledWith({
      page: 3,
      pageSize: 10,
      search: 'jane',
      kycStatus: 'VERIFIED',
      isActive: undefined,
    });
  });

  it('gates Create/Delete on customers.manage', () => {
    // Full-permission operator: manage controls are offered.
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock(['customers.manage']) },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });
    const allowed = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    expect((allowed as any).auth.hasPermission('customers.manage')).toBe(true);

    // Reduced principal (read-only): manage controls are hidden — the template @if is false.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock(['customers.read']) },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });
    const denied = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    expect((denied as any).auth.hasPermission('customers.manage')).toBe(false);
  });

  it('reloads the list (current filter + page) when an SSE event arrives (debounced, A3)', () => {
    vi.useFakeTimers();
    const stream$ = new Subject<DashboardEvent>();
    const stream = { connect: vi.fn(() => stream$) };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock() },
        { provide: DashboardStreamService, useValue: stream },
      ],
    });
    // Reset the shared query$ so this test is independent of param state left by earlier tests.
    query$.next(convertToParamMap({}));
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    component.ngOnInit();
    // The active view: a search filter on page 3 (must be preserved across the live refresh).
    component.search.setValue('jane', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.isActive.setValue('', { emitEvent: false });
    component.page = 3;
    storeMock.load.mockClear();

    // A customer mutation elsewhere → debounced re-load with the CURRENT filter/page.
    stream$.next({ type: 'customer.created', customerId: 'c-1', at: '2026-06-18T00:00:00.000Z' });
    vi.advanceTimersByTime(300);
    expect(storeMock.load).toHaveBeenCalledTimes(1);
    expect(storeMock.load).toHaveBeenCalledWith({
      page: 3,
      pageSize: 10,
      search: 'jane',
      kycStatus: 'VERIFIED',
      isActive: undefined,
    });

    // A burst inside the debounce window coalesces into a single extra load.
    stream$.next({ type: 'customer.updated', customerId: 'c-1', at: '2026-06-18T00:00:01.000Z' });
    stream$.next({ type: 'customer.deleted', customerId: 'c-1', at: '2026-06-18T00:00:01.100Z' });
    vi.advanceTimersByTime(300);
    expect(storeMock.load).toHaveBeenCalledTimes(2);

    // Teardown unsubscribes via destroy$ — a later event no longer reloads.
    component.ngOnDestroy();
    stream$.next({ type: 'customer.created', customerId: 'c-2', at: '2026-06-18T00:00:02.000Z' });
    vi.advanceTimersByTime(300);
    expect(storeMock.load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('admin reveal toggle re-loads current filter/page with reveal:true, then masks again off (AC3/4/8)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock(['customers.read', 'customers.pii.reveal']) },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    // Default masked (AC8).
    expect(component.reveal()).toBe(false);

    component.search.setValue('jane', { emitEvent: false });
    component.kycStatus.setValue('VERIFIED', { emitEvent: false });
    component.page = 3;
    storeMock.load.mockClear();

    // ON: re-load with reveal:true, current filter/page preserved (AC3).
    component.toggleReveal();
    expect(component.reveal()).toBe(true);
    expect(storeMock.load).toHaveBeenLastCalledWith({
      page: 3,
      pageSize: 10,
      search: 'jane',
      kycStatus: 'VERIFIED',
      isActive: undefined,
      reveal: true,
    });

    // OFF: re-load WITHOUT reveal — masked again (AC4, proves no local transform).
    component.toggleReveal();
    expect(component.reveal()).toBe(false);
    expect(storeMock.load).toHaveBeenLastCalledWith({
      page: 3,
      pageSize: 10,
      search: 'jane',
      kycStatus: 'VERIFIED',
      isActive: undefined,
      reveal: undefined,
    });
  });

  it('never reveals for principals without customers.pii.reveal (AC5 — toggle gate fails closed)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: storeMock },
        { provide: AuthService, useValue: authMock(['customers.read', 'customers.manage']) },
        { provide: DashboardStreamService, useValue: streamMock() },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new CustomerListComponent(routerMock as any, routeMock as any, i18nMock as any),
    );
    expect((component as any).auth.hasPermission('customers.pii.reveal')).toBe(false);
    expect(component.reveal()).toBe(false);
  });
});
