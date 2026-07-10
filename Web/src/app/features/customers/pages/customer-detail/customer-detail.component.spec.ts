/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CustomerDetailComponent } from './customer-detail.component';
import {
  CustomersStore,
  TransactionsStore,
  KycVerificationsStore,
} from '@features/customers/state';
import { AuthService } from '@core/auth/auth.service';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { convertToParamMap } from '@angular/router';
import { PageTitleService } from '../../../../layout/page-title.service';

/** Central locale-format stub (B2): en-US behavior, enough for display assertions. */
const localeFmtStub = {
  localeTag: () => 'en-US',
  number: (v: number) => v.toLocaleString('en-US'),
  currency: (v: number, c: string) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: c,
      currencyDisplay: 'narrowSymbol',
    }).format(v),
  percent: (v: number) => `${v}%`,
  date: (v: string | number | Date) => new Date(v).toDateString(),
} as any;

/** Stub AuthService whose granted permission set is controllable per test. */
function authMock(granted: string[] = ['customers.manage', 'wallets.manage-limits']) {
  return { hasPermission: (p: string) => granted.includes(p) } as unknown as AuthService;
}

/** Stub PageTitleService (v2 shell): records the header-H1 override the screen sets. */
function pageTitleMock() {
  return {
    titleKey: () => 'customerDetail.title',
    override: () => null,
    setOverride: vi.fn(),
  } as unknown as PageTitleService & { setOverride: ReturnType<typeof vi.fn> };
}

const customersStoreMock = {
  deleting$: { subscribe: vi.fn() },
  deletingId$: { subscribe: vi.fn() },
  deleteSuccess$: { subscribe: vi.fn() },
  deletingId: null,
  delete: vi.fn(),
};
const transactionsStoreMock = {
  data$: { subscribe: vi.fn() },
  total$: { subscribe: vi.fn() },
  loading$: { subscribe: vi.fn() },
  load: vi.fn(),
};
const kycVerificationsStoreMock = {
  data$: of([]),
  total$: of(0),
  loading$: of(false),
  load: vi.fn(),
};

describe('CustomerDetailComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createComponent() {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CustomersStore,
          useValue: {
            ...customersStoreMock,
            deleting$: { subscribe: vi.fn() },
            deletingId$: { subscribe: vi.fn() },
            deleteSuccess$: { subscribe: vi.fn() },
          },
        },
        { provide: TransactionsStore, useValue: { ...transactionsStoreMock } },
        { provide: KycVerificationsStore, useValue: { ...kycVerificationsStoreMock } },
        { provide: AuthService, useValue: authMock() },
        { provide: PageTitleService, useValue: pageTitleMock() },
      ],
    });

    const route = { paramMap: { pipe: vi.fn() } } as any;
    const router = { navigate: vi.fn() } as any;
    const customersApi = { getById: vi.fn() } as any;
    const walletsApi = { getByCustomerId: vi.fn() } as any;
    const toast = { success: vi.fn() } as any;
    const appError = { handleError: vi.fn() } as any;
    const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;

    const component = TestBed.runInInjectionContext(
      () =>
        new CustomerDetailComponent(
          route,
          router,
          customersApi,
          walletsApi,
          toast,
          appError,
          i18n,
          localeFmtStub,
        ),
    );
    return { component, router, customersApi, walletsApi, appError };
  }

  it('uses static breadcrumbs without putting the customer name in the trail', () => {
    const { component } = createComponent();
    expect(component.breadcrumbItems).toEqual([
      { labelKey: 'customers.title', link: '/customers' },
      { labelKey: 'customerDetail.title' },
    ]);
  });

  it('navigates back and dispatches delete', () => {
    const { component, router } = createComponent();
    component.id = '1';

    component.back();
    component.edit();
    component.web3Risk();

    component.openDelete();
    component.confirmDelete();
    expect(customersStoreMock.delete).toHaveBeenCalledWith('1');
    expect(router.navigate).toHaveBeenCalledWith(['/customers']);
    expect(router.navigate).toHaveBeenCalledWith(['/customers', '1', 'edit']);
    expect(router.navigate).toHaveBeenCalledWith(['/customers', '1', 'web3-risk']);
  });

  it('confirmDelete exits when deleting or missing id', () => {
    const { component } = createComponent();
    component.deletingCustomer.set(true);
    component.id = '1';
    component.confirmDelete();

    component.deletingCustomer.set(false);
    component.id = '';
    component.confirmDelete();

    expect(customersStoreMock.delete).not.toHaveBeenCalled();
  });

  it('ngOnDestroy completes subjects', () => {
    const { component } = createComponent();
    component.ngOnDestroy();
    expect(true).toBe(true);
  });

  it('ngOnInit loads customer and wallet, reacts to deleting + deleteSuccess streams', () => {
    const param$ = new BehaviorSubject(convertToParamMap({ id: '1' }));
    const deleteSuccess$ = new Subject<{ id: string }>();
    const deleting$ = new BehaviorSubject<boolean>(false);
    const deletingId$ = new BehaviorSubject<string | null>(null);
    const customersStore = { deleting$, deletingId$, deleteSuccess$, delete: vi.fn() };
    const transactionsStore = { data$: of([]), total$: of(0), loading$: of(false), load: vi.fn() };
    const kycVerificationsStore = {
      data$: of([]),
      total$: of(0),
      loading$: of(false),
      load: vi.fn(),
    };
    const route = { paramMap: param$ } as any;
    const router = { navigate: vi.fn() } as any;
    const customersApi = { getById: vi.fn(() => of({ id: '1', name: 'A' } as any)) } as any;
    const walletsApi = {
      getByCustomerId: vi.fn(() => of({ id: 'w', dailyLimit: 1, monthlyLimit: 2 } as any)),
    } as any;
    const toast = { success: vi.fn() } as any;
    const appError = { handleError: vi.fn() } as any;
    const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;

    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: customersStore },
        { provide: TransactionsStore, useValue: transactionsStore },
        { provide: KycVerificationsStore, useValue: kycVerificationsStore },
        { provide: AuthService, useValue: authMock() },
        { provide: PageTitleService, useValue: pageTitleMock() },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () =>
        new CustomerDetailComponent(
          route,
          router,
          customersApi,
          walletsApi,
          toast,
          appError,
          i18n,
          localeFmtStub,
        ),
    );
    component.ngOnInit();

    expect(customersApi.getById).toHaveBeenCalledWith('1');
    expect(walletsApi.getByCustomerId).toHaveBeenCalledWith('1');
    expect(component.customer()?.name).toBe('A');
    expect(component.wallet()?.id).toBe('w');

    deleting$.next(true);
    deletingId$.next('2');
    expect(component.deletingCustomer()).toBe(false);
    deletingId$.next('1');
    expect(component.deletingCustomer()).toBe(true);

    component.openDelete();
    deleteSuccess$.next({ id: '1' });
    expect(component.deleteModalOpen()).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/customers']);
  });

  it('handles load errors for customer and wallet', () => {
    const param$ = new BehaviorSubject(convertToParamMap({ id: '1' }));
    const customersStore = {
      deleting$: of(false),
      deletingId$: of(null),
      deleteSuccess$: new Subject(),
      delete: vi.fn(),
    };
    const transactionsStore = { data$: of([]), total$: of(0), loading$: of(false), load: vi.fn() };
    const kycVerificationsStore = {
      data$: of([]),
      total$: of(0),
      loading$: of(false),
      load: vi.fn(),
    };
    const route = { paramMap: param$ } as any;
    const router = { navigate: vi.fn() } as any;
    const customersApi = { getById: vi.fn(() => throwError(() => new Error('boom'))) } as any;
    const walletsApi = {
      getByCustomerId: vi.fn(() => throwError(() => new Error('boom'))),
    } as any;
    const toast = { success: vi.fn() } as any;
    const appError = { handleError: vi.fn() } as any;
    const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;

    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: customersStore },
        { provide: TransactionsStore, useValue: transactionsStore },
        { provide: KycVerificationsStore, useValue: kycVerificationsStore },
        { provide: AuthService, useValue: authMock() },
        { provide: PageTitleService, useValue: pageTitleMock() },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () =>
        new CustomerDetailComponent(
          route,
          router,
          customersApi,
          walletsApi,
          toast,
          appError,
          i18n,
          localeFmtStub,
        ),
    );
    component.ngOnInit();

    expect(appError.handleError).toHaveBeenCalled();
    expect(component.loadingCustomer()).toBe(false);
    expect(component.loadingWallet()).toBe(false);
  });

  it('routes a wallet load error through AppErrorService after the customer loads', () => {
    const param$ = new BehaviorSubject(convertToParamMap({ id: '1' }));
    const customersStore = {
      deleting$: of(false),
      deletingId$: of(null),
      deleteSuccess$: new Subject(),
      delete: vi.fn(),
    };
    const transactionsStore = { data$: of([]), total$: of(0), loading$: of(false), load: vi.fn() };
    const kycVerificationsStore = {
      data$: of([]),
      total$: of(0),
      loading$: of(false),
      load: vi.fn(),
    };
    const customersApi = { getById: vi.fn(() => of({ id: '1', name: 'A' } as any)) } as any;
    const walletsApi = {
      getByCustomerId: vi.fn(() => throwError(() => new Error('wallet down'))),
    } as any;
    const appError = { handleError: vi.fn() } as any;

    TestBed.configureTestingModule({
      providers: [
        { provide: CustomersStore, useValue: customersStore },
        { provide: TransactionsStore, useValue: transactionsStore },
        { provide: KycVerificationsStore, useValue: kycVerificationsStore },
        { provide: AuthService, useValue: authMock() },
        { provide: PageTitleService, useValue: pageTitleMock() },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () =>
        new CustomerDetailComponent(
          { paramMap: param$ } as any,
          { navigate: vi.fn() } as any,
          customersApi,
          walletsApi,
          { success: vi.fn() } as any,
          appError,
          { instant: (k: string) => k, currentLang: 'en' } as any,
          localeFmtStub,
        ),
    );
    component.ngOnInit();

    expect(appError.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'loadWallet' }),
    );
    expect(component.loadingWallet()).toBe(false);
  });

  it('reloadWallet re-fetches and mirrors the fresh wallet; guards a missing id', () => {
    const { component, walletsApi } = createComponent();
    // No id → no fetch.
    component.id = '';
    component.reloadWallet();
    expect(walletsApi.getByCustomerId).not.toHaveBeenCalled();

    component.id = '5';
    walletsApi.getByCustomerId.mockReturnValue(
      of({ id: 'w2', currency: 'TRY', balance: 9 } as any),
    );
    component.reloadWallet();
    expect(walletsApi.getByCustomerId).toHaveBeenCalledWith('5');
    expect(component.wallet()?.id).toBe('w2');
  });

  it('reloadWallet routes a fetch error through AppErrorService', () => {
    const { component, walletsApi, appError } = createComponent();
    component.id = '5';
    walletsApi.getByCustomerId.mockReturnValue(throwError(() => new Error('nope')));
    component.reloadWallet();
    expect(appError.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'reloadWallet' }),
    );
  });

  it('onWalletUpdated mirrors the child-saved wallet onto the rail', () => {
    const { component } = createComponent();
    component.onWalletUpdated({ id: 'w9', currency: 'TRY', balance: 0 } as any);
    expect(component.wallet()?.id).toBe('w9');
  });

  // --- Redesign (§7.4): section-based layout + identity display helpers ---

  it('uses a section-based layout without tab state', () => {
    const { component } = createComponent();
    expect((component as any).tabs).toBeUndefined();
    expect((component as any).activeTab).toBeUndefined();
    expect(component.breadcrumbItems.at(-1)).toEqual({ labelKey: 'customerDetail.title' });
  });

  it('keeps Web3 risk and delete as direct actions', () => {
    const { component, router } = createComponent();
    component.id = '7';
    component.web3Risk();
    expect(router.navigate).toHaveBeenCalledWith(['/customers', '7', 'web3-risk']);
    expect(component.deleteModalOpen()).toBe(false);

    component.openDelete();
    expect(component.deleteModalOpen()).toBe(true);
  });

  it('does not expose an overflow delete menu', () => {
    const { component } = createComponent();
    expect((component as any).deleteMenuEntries).toBeUndefined();
    expect((component as any).onMenuSelect).toBeUndefined();
  });

  it('returns null display values until the data loads, then formats them', () => {
    const { component } = createComponent();
    // Nothing loaded → tiles render their empty state.
    expect(component.walletBalanceDisplay()).toBeNull();
    expect(component.memberSinceDisplay()).toBeNull();

    component.wallet.set({ balance: 1500, currency: 'TRY' } as any);
    expect(component.walletBalanceDisplay()).toContain('1,500');

    component.customer.set({ createdAt: '2023-04-05T00:00:00Z' } as any);
    expect(component.memberSinceDisplay()).not.toBeNull();
  });

  it('guards a bad createdAt and an unknown currency code without throwing', () => {
    const { component } = createComponent();
    component.customer.set({ createdAt: 'not-a-date', kycStatus: 'PENDING' } as any);
    expect(component.memberSinceDisplay()).toBeNull();

    component.wallet.set({ balance: 42, currency: 'ZZZ' } as any);
    // Invalid ISO currency → falls back to "<number> <code>".
    expect(component.walletBalanceDisplay()).toContain('ZZZ');
  });

  it('falls back to number plus currency when the locale currency formatter throws', () => {
    const { component } = createComponent();
    (component as unknown as { fmt: typeof localeFmtStub }).fmt = {
      ...localeFmtStub,
      currency: vi.fn(() => {
        throw new Error('bad currency');
      }),
    };

    component.wallet.set({ balance: 42, currency: 'BAD' } as any);

    expect(component.walletBalanceDisplay()).toBe('42 BAD');
  });

  it('gates edit/delete on customers.manage', () => {
    const { component } = createComponent();
    expect((component as any).auth.hasPermission('customers.manage')).toBe(true);
    expect((component as any).auth.hasPermission('wallets.manage-limits')).toBe(true);
  });
});

// Role-based PII reveal. Drives ngOnInit (working route) so the reveal re-fetch
// path is live, then asserts the toggle re-fetches with/without reveal=true and never retains unmasked PII.
describe('CustomerDetailComponent — PII reveal toggle', () => {
  const MASKED = {
    id: '1',
    name: 'Ada L***',
    email: 'a***@e***.com',
    phone: '*** *** 4567',
    walletNumber: '****3456',
    nationalId: '1234',
    dateOfBirth: '',
    address: { country: 'TR', city: '', postalCode: '', line1: '1***' },
    kycStatus: 'VERIFIED',
    isActive: true,
    createdAt: '',
    updatedAt: '',
    rowVersion: 0,
  } as any;
  const RAW = {
    ...MASKED,
    name: 'Ada Lovelace',
    email: 'ada@x.io',
    phone: '+90 555 123 4567',
    walletNumber: '1234567890123456',
    address: {
      country: 'TR',
      city: 'Istanbul',
      postalCode: '34000',
      line1: '1 Analytical Engine St',
    },
  } as any;

  function makeComponent(
    granted: string[],
    getByIdImpl: (id: string, opts?: { reveal?: boolean }) => any,
  ) {
    const param$ = new BehaviorSubject(convertToParamMap({ id: '1' }));
    const customersApi = { getById: vi.fn(getByIdImpl) } as any;
    const walletsApi = {
      getByCustomerId: vi.fn(() =>
        of({
          id: 'w',
          status: 'ACTIVE',
          currency: 'TRY',
          balance: 0,
          dailyLimit: 1,
          monthlyLimit: 2,
          rowVersion: 0,
        } as any),
      ),
    } as any;
    const appError = { handleError: vi.fn() } as any;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: CustomersStore,
          useValue: {
            deleting$: of(false),
            deletingId$: of(null),
            deleteSuccess$: new Subject(),
            delete: vi.fn(),
          },
        },
        {
          provide: TransactionsStore,
          useValue: { data$: of([]), total$: of(0), loading$: of(false), load: vi.fn() },
        },
        {
          provide: KycVerificationsStore,
          useValue: { data$: of([]), total$: of(0), loading$: of(false), load: vi.fn() },
        },
        { provide: AuthService, useValue: authMock(granted) },
        { provide: PageTitleService, useValue: pageTitleMock() },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () =>
        new CustomerDetailComponent(
          { paramMap: param$ } as any,
          { navigate: vi.fn() } as any,
          customersApi,
          walletsApi,
          { success: vi.fn() } as any,
          appError,
          { instant: (k: string) => k, currentLang: 'en' } as any,
          localeFmtStub,
        ),
    );
    component.ngOnInit();
    return { component, customersApi, appError, param$ };
  }

  const granted = ['customers.manage', 'customers.pii.reveal'];

  it('starts masked; the initial load carries no reveal (AC8)', () => {
    const { component, customersApi } = makeComponent(granted, (_id, opts) =>
      of(opts?.reveal ? RAW : MASKED),
    );
    expect(component.reveal()).toBe(false);
    expect(customersApi.getById).toHaveBeenCalledWith('1'); // no opts ⇒ masked
    expect(component.customer()?.name).toBe('Ada L***');
  });

  it('toggling ON re-fetches with reveal=true (raw PII, national-id last-4); OFF re-fetches masked (AC2/4/7)', () => {
    const { component, customersApi } = makeComponent(granted, (_id, opts) =>
      of(opts?.reveal ? RAW : MASKED),
    );

    component.toggleReveal();
    expect(component.reveal()).toBe(true);
    expect(customersApi.getById).toHaveBeenLastCalledWith('1', { reveal: true });
    expect(component.customer()?.name).toBe('Ada Lovelace');
    expect(component.customer()?.address.line1).toBe('1 Analytical Engine St');
    expect(component.customer()?.nationalId).toBe('1234'); // never widened

    component.toggleReveal();
    expect(component.reveal()).toBe(false);
    expect(customersApi.getById).toHaveBeenLastCalledWith('1', { reveal: false });
    // No retained unmasked state — the bound model holds the masked response (AC7).
    expect(component.customer()?.name).toBe('Ada L***');
    expect(component.customer()?.address.line1).toBe('1***');
  });

  it('drops revealed PII immediately while the masked response is still pending', () => {
    const maskedResponse$ = new Subject<any>();
    let call = 0;
    const { component } = makeComponent(granted, (_id, opts) => {
      call += 1;
      if (call === 1) return of(MASKED);
      if (opts?.reveal) return of(RAW);
      return maskedResponse$;
    });

    component.toggleReveal();
    expect(component.customer()?.name).toBe('Ada Lovelace');

    component.toggleReveal();
    expect(component.reveal()).toBe(false);
    expect(component.customer()).toBeNull();

    maskedResponse$.next(MASKED);
    expect(component.customer()?.name).toBe('Ada L***');
  });

  it('renders masked WITHOUT error when a reveal=true re-fetch is server-downgraded to masked (AC10)', () => {
    const { component, appError } = makeComponent(granted, () => of(MASKED)); // server always masks (grant lapsed)
    component.toggleReveal();
    expect(component.customer()?.name).toBe('Ada L***');
    expect(appError.handleError).not.toHaveBeenCalled();
  });

  it('resets reveal to false on an id change (no persistence across navigation)', () => {
    const { component, param$ } = makeComponent(granted, (_id, opts) =>
      of(opts?.reveal ? RAW : MASKED),
    );
    component.toggleReveal();
    expect(component.reveal()).toBe(true);
    param$.next(convertToParamMap({ id: '2' }));
    expect(component.reveal()).toBe(false);
    expect(component.customer()?.name).toBe('Ada L***');
  });

  it('a principal without customers.pii.reveal never reveals (AC5/AC6 fail-closed gate)', () => {
    const { component } = makeComponent(['customers.manage'], (_id, opts) =>
      of(opts?.reveal ? RAW : MASKED),
    );
    expect((component as any).auth.hasPermission('customers.pii.reveal')).toBe(false);
    expect(component.reveal()).toBe(false);
    expect(component.customer()?.name).toBe('Ada L***');
  });
});
