/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { HeaderComponent } from './header.component';
import { TranslateService } from '@ngx-translate/core';
import { OperatorApi, OperatorProfile } from '@core/api/operator.api';
import { LoadingService } from '@core/services/loading.service';
import { ThemeService } from '@core/services/theme.service';
import { AuthService } from '@core/auth/auth.service';
import { NotificationStore } from '@core/state/notification.store';
import { PageTitleService } from '../page-title.service';

const authStub = { principal: () => null, logout: vi.fn(() => of(undefined)) };
const routerStub = { navigate: vi.fn() };
const pageTitleStub = {
  titleKey: () => 'app.title',
  override: () => null,
  setOverride: vi.fn(),
};
/** The header now reads the shared NotificationStore (signals) instead of OperatorApi. */
const notificationStoreStub = {
  recent: () => [] as unknown[],
  unreadCount: () => 0,
  hasUnread: () => false,
  loaded: () => true,
  init: vi.fn(),
  refresh: vi.fn(),
  markRead: vi.fn(),
  markAll: vi.fn(),
};
/** A host element so the document-pointerdown outside-click guard can query its cluster. */
const elementRefStub = new ElementRef(document.createElement('header'));

describe('HeaderComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    authStub.logout.mockClear();
    notificationStoreStub.init.mockClear();
    notificationStoreStub.refresh.mockClear();
    notificationStoreStub.markAll.mockClear();
    routerStub.navigate.mockClear();
  });

  it('switches language and resolves currentLang', () => {
    const i18n = { use: vi.fn(), currentLang: 'tr' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );
    component.switchLang('tr');
    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(component.currentLang()).toBe('tr');

    i18n.currentLang = 'en';
    expect(component.currentLang()).toBe('en');
  });

  it('reflects the active language on <html lang> when switching (WCAG 3.1.1)', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );

    component.switchLang('tr');
    expect(document.documentElement.lang).toBe('tr');

    component.switchLang('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('sets theme mode', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );
    component.setTheme('dark');
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
  });

  it('persists selected language when browser storage is available', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );
    component.switchLang('tr');

    expect(setItem).toHaveBeenCalledWith('lang', 'tr');
    setItem.mockRestore();
  });

  it('keeps language switch working when browser storage throws', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );

    expect(() => component.switchLang('tr')).not.toThrow();
    expect(i18n.use).toHaveBeenCalledWith('tr');
    setItem.mockRestore();
  });

  it('keeps language switch working when browser storage is absent', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    vi.stubGlobal('localStorage', undefined);

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );

    expect(() => component.switchLang('tr')).not.toThrow();
    expect(i18n.use).toHaveBeenCalledWith('tr');
  });

  function makeComponent(
    overrides: {
      theme?: {
        theme: () => string;
        setTheme: ReturnType<typeof vi.fn>;
        toggleTheme: ReturnType<typeof vi.fn>;
      };
    } = {},
  ) {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = overrides.theme ?? {
      theme: () => 'light',
      setTheme: vi.fn(),
      toggleTheme: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });

    return TestBed.runInInjectionContext(() => new HeaderComponent(i18n as any, loading as any));
  }

  it('signs out via AuthService.logout() and navigates to /login', () => {
    const component = makeComponent();

    component.onLogout();

    expect(authStub.logout).toHaveBeenCalledTimes(1);
    expect(routerStub.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('is idempotent: a second click while logout is in flight is ignored', () => {
    const component = makeComponent();
    // Logout that never settles, so loggingOut stays true across the second click.
    authStub.logout.mockReturnValueOnce(NEVER);

    component.onLogout();
    component.onLogout();

    expect(authStub.logout).toHaveBeenCalledTimes(1);
    expect(routerStub.navigate).not.toHaveBeenCalled(); // first flow still pending
  });

  it('still navigates to /login when the logout call completes (revoke best-effort)', () => {
    const component = makeComponent();
    authStub.logout.mockReturnValueOnce(of(undefined));

    component.onLogout();

    expect(routerStub.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('toggleTheme delegates to ThemeService.toggleTheme from the toolbar toggle', () => {
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const component = makeComponent({ theme });

    component.toggleTheme();

    expect(theme.toggleTheme).toHaveBeenCalledTimes(1);
  });

  it('exposes the page-title source for the header H1', () => {
    const component = makeComponent();

    expect(component.pageTitle.titleKey()).toBe('app.title');
    expect(component.pageTitle.override()).toBeNull();
  });

  it('emits the trimmed query on search and ignores blank input', () => {
    const component = makeComponent();
    const emitted: string[] = [];
    component.search.subscribe(q => emitted.push(q));

    component.searchControl.setValue('   ');
    component.onSearch();
    expect(emitted).toEqual([]);

    component.searchControl.setValue('  ada lovelace  ');
    component.onSearch();
    expect(emitted).toEqual(['ada lovelace']);
  });

  it('routes Profile and Settings from the user menu', () => {
    const component = makeComponent();

    component.onUserMenuSelect('profile');
    expect(routerStub.navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'profile' },
    });

    component.onUserMenuSelect('settings');
    expect(routerStub.navigate).toHaveBeenCalledWith(['/settings']);
  });

  it('switches language from the header language control', () => {
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: elementRefStub },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as any, loading as any),
    );

    // The EN/TR segmented in the header delegates to the unchanged switchLang flow.
    component.onLangChange('tr');
    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(setItem).toHaveBeenCalledWith('lang', 'tr');

    component.onLangChange('en');
    expect(i18n.use).toHaveBeenCalledWith('en');
    setItem.mockRestore();
  });

  it('keeps the user menu free of language rows — language lives in the header', () => {
    const component = makeComponent();

    const ids = component.userMenuEntries.map(entry => entry.id);
    expect(ids).toEqual(['profile', 'settings', 'sep-logout', 'logout']);

    // The EN/TR switch is a header toolbar control, not a menu row.
    expect(component.langOptions.map(option => option.value)).toEqual(['en', 'tr']);
  });

  it('A18: keeps the approved profile-menu anatomy — icon rows, divider, danger logout last', () => {
    const component = makeComponent();
    const entries = component.userMenuEntries;

    // Iconed 44px rows (icons pinned so the redesigned card renders the approved glyphs).
    expect(entries[0]).toMatchObject({ id: 'profile', icon: 'ri-user-3-line' });
    expect(entries[1]).toMatchObject({ id: 'settings', icon: 'ri-settings-3-line' });
    // Logout separates visually: a divider, then the single danger row at the end.
    expect(entries[2]).toMatchObject({ kind: 'divider' });
    expect(entries[entries.length - 1]).toMatchObject({
      id: 'logout',
      icon: 'ri-logout-box-r-line',
      danger: true,
    });
  });

  it('delegates the Logout user-menu item to onLogout()', () => {
    const component = makeComponent();
    authStub.logout.mockReturnValueOnce(of(undefined));

    component.onUserMenuSelect('logout');

    expect(authStub.logout).toHaveBeenCalledTimes(1);
    expect(routerStub.navigate).toHaveBeenCalledWith(['/login']);
  });

  // --- Reworked interactive notifications dropdown (NotificationStore-backed) ---

  function mountWith(opts: {
    principal?: unknown;
    recent?: unknown[];
    unreadCount?: number;
    profile?: OperatorProfile;
    profileError?: unknown;
  }) {
    TestBed.resetTestingModule();
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const auth = { principal: () => opts.principal ?? null, logout: vi.fn(() => of(undefined)) };
    const operatorApi = {
      getProfile: vi.fn(() =>
        opts.profileError
          ? throwError(() => opts.profileError)
          : of(
              opts.profile ?? {
                displayName: null,
                email: 'operator.full@example.com',
                phone: null,
                jobTitle: null,
              },
            ),
      ),
    };
    const unread = opts.unreadCount ?? 0;
    const store = {
      recent: () => opts.recent ?? [],
      unreadCount: () => unread,
      hasUnread: () => unread > 0,
      loaded: () => true,
      init: vi.fn(),
      refresh: vi.fn(),
      markRead: vi.fn(),
      markAll: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: store },
        { provide: OperatorApi, useValue: operatorApi },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('header')) },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as never, loading as never),
    );
    return { component, store, operatorApi };
  }

  it('starts the shared live feed on init (idempotent store.init)', () => {
    const { component, store } = mountWith({ unreadCount: 0 });
    component.ngOnInit();
    expect(store.init).toHaveBeenCalledTimes(1);
  });

  it('exposes the real unread count + hasUnread from the store', () => {
    const { component } = mountWith({ unreadCount: 3 });
    expect(component.unreadCount()).toBe(3);
    expect(component.hasUnread()).toBe(true);
  });

  it('returns an empty current user when there is no authenticated principal', () => {
    const { component, operatorApi } = mountWith({});

    expect(component.currentUser).toEqual({ name: '', role: '' });
    expect(operatorApi.getProfile).not.toHaveBeenCalled();
  });

  it('fetches the operator profile email once and shows the unmasked own email', () => {
    const principal = {
      user: {
        displayName: 'Ada Operator',
        email: 'a***@e***.com',
      },
    };
    const { component, operatorApi } = mountWith({
      principal,
      profile: {
        displayName: 'Ada Operator',
        email: 'ada.operator@example.com',
        phone: null,
        jobTitle: 'Ops',
      },
    });

    expect(component.currentUser).toEqual({
      name: 'Ada Operator',
      role: 'ada.operator@example.com',
    });
    expect(component.currentUser).toEqual({
      name: 'Ada Operator',
      role: 'ada.operator@example.com',
    });
    expect(operatorApi.getProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps the masked principal email when the own-profile lookup fails', () => {
    const principal = {
      user: {
        displayName: 'Ada Operator',
        email: 'a***@e***.com',
      },
    };
    const { component, operatorApi } = mountWith({
      principal,
      profileError: new Error('profile unavailable'),
    });

    expect(component.currentUser).toEqual({ name: 'Ada Operator', role: 'a***@e***.com' });
    expect(operatorApi.getProfile).toHaveBeenCalledTimes(1);
  });

  it('uses the own full email as the primary line when the principal has no display name', () => {
    const principal = {
      user: {
        displayName: null,
        email: 'o***@e***.com',
      },
    };
    const { component } = mountWith({
      principal,
      profile: {
        displayName: null,
        email: 'operator.full@example.com',
        phone: null,
        jobTitle: null,
      },
    });

    expect(component.currentUser).toEqual({ name: 'operator.full@example.com', role: '' });
  });

  it('maps a notification type to a STATIC label key + icon (no dynamic key building)', () => {
    const { component } = mountWith({});
    // BE NotificationType enum values → static i18n keys + icons.
    expect(component.notificationLabel('CUSTOMER_EVENT')).toBe('notifications.type.customerEvent');
    expect(component.notificationLabel('KYC_EVENT')).toBe('notifications.type.kycEvent');
    expect(component.notificationIcon('SECURITY_ALERT')).toBe('ri-error-warning-line');
    // An unknown/forward-compatible type falls back to the generic key/icon rather than crashing.
    expect(component.notificationLabel('BRAND_NEW_TYPE')).toBe('notifications.type.activity');
    expect(component.notificationIcon('BRAND_NEW_TYPE')).toBe('ri-notification-3-line');
  });

  it('produces a relative-time key for a recent timestamp', () => {
    const { component } = mountWith({});
    const justNow = component.notificationTime(new Date().toISOString());
    expect(justNow.key).toBe('common.time.justNow');
    const anHourAgo = component.notificationTime(new Date(Date.now() - 3_600_000).toISOString());
    expect(anHourAgo.key).toBe('common.time.hoursAgo');
    expect(anHourAgo.params).toEqual({ count: 1 });
  });

  it('maps severity to a badge colour family + a STATIC label key (mirrors the /notifications page)', () => {
    const { component } = mountWith({});
    // Severity → badge colour (the badge also carries text, so colour is never the only signal).
    expect(component.severityColor('info')).toBe('blue');
    expect(component.severityColor('success')).toBe('green');
    expect(component.severityColor('warning')).toBe('yellow');
    expect(component.severityColor('critical')).toBe('red');
    // Severity → static i18n key (no dynamic key building).
    expect(component.severityKey('info')).toBe('notifications.severity.info');
    expect(component.severityKey('critical')).toBe('notifications.severity.critical');
    // An out-of-union value falls back rather than crashing.
    expect(component.severityColor('mystery' as never)).toBe('gray');
    expect(component.severityKey('mystery' as never)).toBe('notifications.severity.info');
  });

  it('resolves the title via the BE titleKey (falling back when the FE bundle lacks it)', () => {
    // Mirrors the body path: a present key resolves to its text; a missing key (ngx-translate echoes it)
    // substitutes the generic fallback title copy.
    const i18n = {
      use: vi.fn(),
      currentLang: 'en',
      instant: (key: string) =>
        key === 'notifications.title.kyc'
          ? 'KYC status changed'
          : key === 'notifications.fallback.title'
            ? 'New notification'
            : key,
    };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('header')) },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as never, loading as never),
    );

    expect(
      component.notificationTitle({ titleKey: 'notifications.title.kyc', params: null } as never),
    ).toBe('KYC status changed');
    // Missing key → ngx-translate echoes it → we substitute the generic fallback title.
    expect(
      component.notificationTitle({
        titleKey: 'notifications.title.missing',
        params: null,
      } as never),
    ).toBe('New notification');
  });

  it('resolves the body snippet via the BE bodyKey (falling back when the FE bundle lacks it)', () => {
    // A translate stub that echoes the key (ngx-translate behaviour for a missing key) lets us
    // assert the fallback path; a present key resolves to its text.
    const i18n = {
      use: vi.fn(),
      currentLang: 'en',
      instant: (key: string) =>
        key === 'notifications.body.kyc'
          ? 'KYC approved for Ada'
          : key === 'notifications.fallback.body'
            ? 'You have a new notification.'
            : key,
    };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('header')) },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as never, loading as never),
    );

    expect(
      component.notificationBody({ bodyKey: 'notifications.body.kyc', params: null } as never),
    ).toBe('KYC approved for Ada');
    // Missing key → ngx-translate echoes it → we substitute the generic fallback copy.
    expect(
      component.notificationBody({ bodyKey: 'notifications.body.missing', params: null } as never),
    ).toBe('You have a new notification.');
  });

  it('toggles the popover and refreshes the feed when opening', () => {
    const { component, store } = mountWith({ unreadCount: 1 });
    expect(component.notificationsOpen()).toBe(false);
    component.toggleNotifications();
    expect(component.notificationsOpen()).toBe(true);
    expect(store.refresh).toHaveBeenCalledTimes(1);
    component.toggleNotifications();
    expect(component.notificationsOpen()).toBe(false);
  });

  it('moves focus into the dialog on open and restores focus on Escape (A11Y-002)', () => {
    vi.useFakeTimers();
    try {
      const { component } = mountWith({ unreadCount: 1 });
      component.toggleNotifications(); // open → schedules the focus-into-dialog microtask
      vi.runOnlyPendingTimers(); // flush the deferred focus call
      component.onEscapeKey(); // Esc closes + restores focus to the trigger
      expect(component.notificationsOpen()).toBe(false);
      // A second Escape while already closed is a no-op (the early-return guard).
      component.onEscapeKey();
      expect(component.notificationsOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the popover on an outside pointer-down, and keeps it open for a click inside the cluster', () => {
    // Build a host with a real `.notifications` cluster so the outside-click guard can query + containment-test it.
    TestBed.resetTestingModule();
    const i18n = { use: vi.fn(), currentLang: 'en' };
    const loading = { loading$: { subscribe: vi.fn() } };
    const theme = { theme: () => 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
    const host = document.createElement('header');
    const cluster = document.createElement('div');
    cluster.className = 'notifications';
    const inside = document.createElement('button');
    cluster.appendChild(inside);
    host.appendChild(cluster);
    const outside = document.createElement('div'); // NOT within the cluster
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: LoadingService, useValue: loading },
        { provide: ThemeService, useValue: theme },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        { provide: PageTitleService, useValue: pageTitleStub },
        { provide: NotificationStore, useValue: notificationStoreStub },
        { provide: ElementRef, useValue: new ElementRef(host) },
      ],
    });
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(i18n as never, loading as never),
    );

    // Closed: the guard early-returns (nothing to do) regardless of the target.
    component.onDocumentPointerDown({ target: outside } as unknown as PointerEvent);
    expect(component.notificationsOpen()).toBe(false);

    // Open, then a click INSIDE the cluster leaves it open.
    component.toggleNotifications();
    expect(component.notificationsOpen()).toBe(true);
    component.onDocumentPointerDown({ target: inside } as unknown as PointerEvent);
    expect(component.notificationsOpen()).toBe(true);

    // A click OUTSIDE the cluster closes it.
    component.onDocumentPointerDown({ target: outside } as unknown as PointerEvent);
    expect(component.notificationsOpen()).toBe(false);
  });

  it('does NOT navigate for a row whose resource type is unrecognised (no fabricated link)', () => {
    // resourceId present but resourceType is not `customer` → notificationRoute returns null.
    const { component, store } = mountWith({});
    component.onNotificationClick({
      id: 'n3',
      type: 'SYSTEM',
      severity: 'info',
      titleKey: 'x',
      bodyKey: 'x',
      params: null,
      resourceType: 'wallet',
      resourceId: 'w-1',
      readAt: null,
      createdAt: new Date().toISOString(),
    } as never);
    // Still marks-read in place (it was unread) but performs NO navigation.
    expect(store.markRead).toHaveBeenCalledWith('n3');
    expect(routerStub.navigate).not.toHaveBeenCalled();
    expect(component.notificationsOpen()).toBe(false);
  });

  it('switchLang is a no-op on <html lang> when document is unavailable (SSR/headless guard)', () => {
    const component = makeComponent();
    vi.stubGlobal('document', undefined);
    // The applyDocumentLang guard returns early when `document` is undefined — no throw.
    expect(() => component.switchLang('tr')).not.toThrow();
  });

  it('clicking an UNREAD row marks it read and navigates to the customer resource', () => {
    const { component, store } = mountWith({});
    component.onNotificationClick({
      id: 'n1',
      type: 'CUSTOMER_EVENT',
      severity: 'info',
      titleKey: 'notifications.type.customerEvent',
      bodyKey: 'x',
      params: null,
      resourceType: 'customer',
      resourceId: 'c-9',
      readAt: null,
      createdAt: new Date().toISOString(),
    } as never);
    expect(store.markRead).toHaveBeenCalledWith('n1');
    expect(routerStub.navigate).toHaveBeenCalledWith(['/customers', 'c-9'], undefined);
    expect(component.notificationsOpen()).toBe(false);
  });

  it('EK-2: a password_reset_request alert deep-links to the merged admin recovery page with ?request=', () => {
    const { component, store } = mountWith({});
    component.onNotificationClick({
      id: 'n4',
      type: 'SECURITY_ALERT',
      severity: 'warning',
      titleKey: 'notifications.security.resetRequestCreated.title',
      bodyKey: 'notifications.security.resetRequestCreated.body',
      params: null,
      resourceType: 'password_reset_request',
      resourceId: 'req-9',
      readAt: null,
      createdAt: new Date().toISOString(),
    } as never);
    expect(store.markRead).toHaveBeenCalledWith('n4');
    // The embedded review section on /admin-password-reset preselects the request the param names.
    expect(routerStub.navigate).toHaveBeenCalledWith(['/admin-password-reset'], {
      queryParams: { request: 'req-9' },
    });
    expect(component.notificationsOpen()).toBe(false);
  });

  it('clicking an already-READ row with no resource does NOT mark-read and does NOT navigate', () => {
    const { component, store } = mountWith({});
    component.onNotificationClick({
      id: 'n2',
      type: 'SYSTEM',
      severity: 'info',
      titleKey: 'x',
      bodyKey: 'x',
      params: null,
      resourceType: null,
      resourceId: null,
      readAt: '2026-06-29T00:00:00Z',
      createdAt: '2026-06-29T00:00:00Z',
    } as never);
    expect(store.markRead).not.toHaveBeenCalled();
    expect(routerStub.navigate).not.toHaveBeenCalled();
  });

  it('mark-all delegates to the store', () => {
    const { component, store } = mountWith({ unreadCount: 2 });
    component.markAllNotificationsRead();
    expect(store.markAll).toHaveBeenCalledTimes(1);
  });

  it('"see all" navigates to /notifications and closes the popover', () => {
    const { component } = mountWith({ unreadCount: 0 });
    component.toggleNotifications();
    component.goToAllNotifications();
    expect(routerStub.navigate).toHaveBeenCalledWith(['/notifications']);
    expect(component.notificationsOpen()).toBe(false);
  });

  it('derives the current user from the real principal', () => {
    expect(mountWith({ principal: null }).component.currentUser).toEqual({ name: '', role: '' });
    expect(
      mountWith({
        principal: { user: { displayName: 'Ada', email: 'a@x.io' } },
        profile: { displayName: 'Ada', email: 'a@x.io', phone: null, jobTitle: null },
      }).component.currentUser,
    ).toEqual({ name: 'Ada', role: 'a@x.io' });
    expect(
      mountWith({
        principal: { user: { displayName: null, email: 'a@x.io' } },
        profile: { displayName: null, email: 'a@x.io', phone: null, jobTitle: null },
      }).component.currentUser,
    ).toEqual({ name: 'a@x.io', role: '' });
  });
});
