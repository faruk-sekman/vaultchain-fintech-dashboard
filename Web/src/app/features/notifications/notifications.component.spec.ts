/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the notifications page. Covers: initial load + state mapping, the four render
 * states (loading/error/empty/populated reachable via signals), filters resetting to page 1, pagination,
 * mark-read (optimistic + rollback), row → resource navigation, SSE-driven reload, the static severity
 * map, and clearFilters. ApiClientService is NOT touched — NotificationApi/NotificationStore/stream are
 * stubbed at the seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Observable, Subject, of, throwError } from 'rxjs';
import { NotificationApi, NotificationPage } from '@core/api/notification.api';
import { NotificationStore } from '@core/state/notification.store';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { NotificationsComponent } from './notifications.component';

function pageOf(overrides: Partial<NotificationPage> = {}): NotificationPage {
  return {
    data: [],
    page: { page: 1, pageSize: 15, total: 0 },
    unreadCount: 0,
    ...overrides,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    type: 'KYC_EVENT',
    severity: 'info',
    titleKey: 'notifications.kyc.statusChanged.title',
    bodyKey: 'notifications.kyc.statusChanged.body',
    params: null,
    resourceType: 'customer',
    resourceId: 'c-1',
    readAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function setup(
  opts: { list?: Observable<NotificationPage>; stream?: Subject<unknown>; unread?: number } = {},
) {
  const stream$ = opts.stream ?? new Subject<unknown>();
  const api = {
    list: vi.fn(() => opts.list ?? of(pageOf())),
    markRead: vi.fn(() => of(0)),
    markAll: vi.fn(() => of(0)),
  };
  // The component re-exports the store's `unreadCount` signal for the summary head + mark-all guard.
  const unreadCount = signal(opts.unread ?? 0);
  const store = { refresh: vi.fn(), markAll: vi.fn(), unreadCount };
  const stream = { connectNotifications: vi.fn(() => stream$.asObservable()) };
  const router = { navigate: vi.fn() };
  const i18n = { instant: (k: string) => k };

  TestBed.configureTestingModule({
    providers: [
      { provide: NotificationApi, useValue: api },
      { provide: NotificationStore, useValue: store },
      { provide: DashboardStreamService, useValue: stream },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new NotificationsComponent());
  return { component, api, store, router, stream$, unreadCount };
}

describe('NotificationsComponent', () => {
  beforeEach(() => vi.clearAllMocks());
  // Global stubs (IntersectionObserver) must be undone even when a test fails mid-body.
  afterEach(() => vi.unstubAllGlobals());

  it('loads the first page on init and maps items + total', () => {
    const { component, api } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    component.ngOnInit();
    expect(api.list).toHaveBeenCalledWith({ page: 1, pageSize: 15 });
    expect(component.items().length).toBe(1);
    expect(component.total()).toBe(1);
    expect(component.loading()).toBe(false);
    expect(component.errored()).toBe(false);
  });

  it('a failed load surfaces the error state and clears loading', () => {
    const { component } = setup({ list: throwError(() => new Error('down')) });
    component.ngOnInit();
    expect(component.errored()).toBe(true);
    expect(component.loading()).toBe(false);
  });

  it('applies type/severity/read filters as server query params', () => {
    const { component, api } = setup();
    component.ngOnInit();
    api.list.mockClear();
    // Type uses the BE NotificationType enum value, passed through to the server query.
    component.typeControl.setValue('KYC_EVENT');
    expect(api.list).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 15,
      type: 'KYC_EVENT',
    });
    component.severityControl.setValue('critical');
    component.onReadChange('unread');
    expect(api.list).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 15,
      type: 'KYC_EVENT',
      severity: 'critical',
      read: false,
    });
  });

  it('A13: changing a filter resets the accumulated list to page 1', () => {
    const { component, api } = setup();
    api.list.mockReturnValue(
      of(pageOf({ data: [row({ id: 'n1' })], page: { page: 1, pageSize: 15, total: 45 } })),
    );
    component.ngOnInit();
    component.loadMore();
    expect(component.page()).toBe(2);
    component.typeControl.setValue('SYSTEM');
    expect(component.page()).toBe(1);
  });

  it('A13: loadMore APPENDS the next page, de-duplicated by id', () => {
    const { component, api } = setup();
    api.list.mockReturnValueOnce(
      of(
        pageOf({
          data: [row({ id: 'n1' }), row({ id: 'n2' })],
          page: { page: 1, pageSize: 15, total: 4 },
        }),
      ),
    );
    component.ngOnInit();
    expect(component.items().map(i => i.id)).toEqual(['n1', 'n2']);

    // Next page overlaps n2 (an SSE prepend could shift the window) — the dupe must not double up.
    api.list.mockReturnValueOnce(
      of(
        pageOf({
          data: [row({ id: 'n2' }), row({ id: 'n3' }), row({ id: 'n4' })],
          page: { page: 2, pageSize: 15, total: 4 },
        }),
      ),
    );
    component.loadMore();

    expect(api.list).toHaveBeenLastCalledWith({ page: 2, pageSize: 15 });
    expect(component.items().map(i => i.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(component.allLoaded()).toBe(true); // 4/4 on screen → the tail flips to "all loaded"
  });

  it('A13: a failed append rolls the page back and keeps the accumulated list intact', () => {
    const { component, api } = setup();
    api.list.mockReturnValueOnce(
      of(pageOf({ data: [row({ id: 'n1' })], page: { page: 1, pageSize: 15, total: 30 } })),
    );
    component.ngOnInit();

    api.list.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.loadMore();

    expect(component.page()).toBe(1); // rolled back → the next trigger retries page 2
    expect(component.items().map(i => i.id)).toEqual(['n1']); // list NOT wiped
    expect(component.errored()).toBe(false); // append failure ≠ full-list error state
  });

  it('A13: the SSE merge prepends new rows and refreshes held ones without collapsing the list', () => {
    const { component, api } = setup();
    api.list.mockReturnValueOnce(
      of(
        pageOf({
          data: [row({ id: 'n1' }), row({ id: 'n2' })],
          page: { page: 1, pageSize: 15, total: 2 },
        }),
      ),
    );
    component.ngOnInit();

    // SSE tick: page 1 now leads with a brand-new n0, and n1 got read elsewhere.
    api.list.mockReturnValueOnce(
      of(
        pageOf({
          data: [row({ id: 'n0' }), row({ id: 'n1', readAt: '2026-07-02T10:00:00.000Z' })],
          page: { page: 1, pageSize: 15, total: 3 },
        }),
      ),
    );
    (component as any).refreshTop();

    expect(component.items().map(i => i.id)).toEqual(['n0', 'n1', 'n2']);
    expect(component.items()[1].readAt).toBe('2026-07-02T10:00:00.000Z');
    expect(component.total()).toBe(3);
  });

  it('A13: a failed SSE top refresh leaves the accumulated list unchanged', () => {
    const { component, api, store } = setup();
    api.list.mockReturnValueOnce(
      of(pageOf({ data: [row({ id: 'n1' })], page: { page: 1, pageSize: 15, total: 1 } })),
    );
    component.ngOnInit();
    store.refresh.mockClear();

    api.list.mockReturnValueOnce(throwError(() => new Error('temporary outage')));
    (component as unknown as { refreshTop(): void }).refreshTop();

    expect(component.items().map(item => item.id)).toEqual(['n1']);
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it('clearFilters resets every filter (and the valueChanges reload to page 1)', () => {
    const { component } = setup();
    component.ngOnInit();
    component.typeControl.setValue('SYSTEM');
    component.severityControl.setValue('warning');
    component.onReadChange('read');
    expect(component.hasActiveFilter()).toBe(true);

    component.clearFilters();
    expect(component.typeControl.value).toBe('');
    expect(component.severityControl.value).toBe('');
    expect(component.readControl.value).toBe('all');
    expect(component.hasActiveFilter()).toBe(false);
  });

  it('marking a row read is optimistic and refreshes the shared badge', () => {
    const { component, api, store } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    component.ngOnInit();
    component.markRead(component.items()[0], false);
    expect(component.items()[0].readAt).not.toBeNull(); // optimistic flip
    expect(api.markRead).toHaveBeenCalledWith('n1');
    expect(store.refresh).toHaveBeenCalled();
  });

  it('rolls back the optimistic mark-read when the API fails', () => {
    const { component, api } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    api.markRead.mockReturnValueOnce(throwError(() => new Error('nope')));
    component.ngOnInit();
    component.markRead(component.items()[0], false);
    expect(component.items()[0].readAt).toBeNull(); // rolled back
  });

  it('clicking a row marks it read and navigates to the customer resource', () => {
    const { component, router } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    component.ngOnInit();
    component.onRowClick(component.items()[0]);
    expect(router.navigate).toHaveBeenCalledWith(['/customers', 'c-1'], undefined);
  });

  it('clicking a row with no resource does not navigate', () => {
    const { component, router } = setup({
      list: of(
        pageOf({
          data: [row({ resourceType: null, resourceId: null })] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    component.onRowClick(component.items()[0]);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does NOT navigate for an unrecognised resource type (no fabricated link)', () => {
    const { component, router } = setup({
      list: of(
        pageOf({
          data: [row({ resourceType: 'wallet', resourceId: 'w-1' })] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    expect(component.hasRoute(component.items()[0])).toBe(false);
    component.onRowClick(component.items()[0]);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('clicking an already-READ row with a subject navigates WITHOUT re-marking it read', () => {
    const { component, api, router } = setup({
      list: of(
        pageOf({
          data: [row({ readAt: '2026-06-30T00:00:00Z' })] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    component.onRowClick(component.items()[0]);
    expect(api.markRead).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/customers', 'c-1'], undefined);
  });

  it('loadMore is a no-op while the list is in the errored state (guard)', () => {
    const { component, api } = setup({ list: throwError(() => new Error('down')) });
    component.ngOnInit();
    expect(component.errored()).toBe(true);
    api.list.mockClear();
    component.loadMore();
    expect(api.list).not.toHaveBeenCalled();
    expect(component.page()).toBe(1);
  });

  it('a mark-read rollback patches ONLY the failed row and leaves its neighbours untouched', () => {
    const { component, api } = setup({
      list: of(
        pageOf({
          data: [row({ id: 'n1' }), row({ id: 'n2' })] as never,
          page: { page: 1, pageSize: 15, total: 2 },
        }),
      ),
    });
    api.markRead.mockReturnValueOnce(throwError(() => new Error('nope')));
    component.ngOnInit();
    component.markRead(component.items()[0], false);
    expect(component.items()[0].readAt).toBeNull(); // rolled back
    expect(component.items()[1].readAt).toBeNull(); // neighbour untouched by the patch
  });

  it('EK-2: a password_reset_request row deep-links to the merged admin recovery page with ?request=', () => {
    const { component, router } = setup({
      list: of(
        pageOf({
          data: [
            row({
              type: 'SECURITY_ALERT',
              resourceType: 'password_reset_request',
              resourceId: 'req-9',
            }),
          ] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    expect(component.hasRoute(component.items()[0])).toBe(true);
    component.onRowClick(component.items()[0]);
    // The embedded review section preselects (and scrolls to) the request the query param names.
    expect(router.navigate).toHaveBeenCalledWith(['/admin-password-reset'], {
      queryParams: { request: 'req-9' },
    });
  });

  it('an SSE notification.created event re-pulls the current page (debounced)', () => {
    vi.useFakeTimers();
    const stream$ = new Subject<unknown>();
    const { component, api } = setup({ stream: stream$ });
    component.ngOnInit();
    api.list.mockClear();
    // Real wire shape: the new notification id rides in `customerId` (the BE envelope's id slot).
    stream$.next({
      type: 'notification.created',
      customerId: 'x',
      recipientUserId: 'me',
      at: '2026-06-29T00:00:00Z',
    });
    vi.advanceTimersByTime(350); // clear the debounceTime(300) window
    expect(api.list).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('observes the bottom sentinel and loads the next page when it intersects', () => {
    let callback: IntersectionObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class MockIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }

      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal(
      'IntersectionObserver',
      MockIntersectionObserver as unknown as typeof IntersectionObserver,
    );
    const { component, api } = setup();
    api.list.mockReturnValueOnce(
      of(pageOf({ data: [row({ id: 'n1' })], page: { page: 1, pageSize: 15, total: 30 } })),
    );
    component.ngOnInit();
    api.list.mockClear();

    component.loadMoreSentinel = new ElementRef(document.createElement('div'));
    expect(observe).toHaveBeenCalledTimes(1);
    callback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

    expect(api.list).toHaveBeenCalledWith({ page: 2, pageSize: 15 });
    component.loadMoreSentinel = undefined;
    expect(disconnect).toHaveBeenCalled();
  });

  it('keeps the manual load-more path available when IntersectionObserver is unavailable', () => {
    const { component } = setup();
    vi.stubGlobal('IntersectionObserver', undefined);

    expect(() => {
      component.loadMoreSentinel = new ElementRef(document.createElement('div'));
    }).not.toThrow();
  });

  it('markAll delegates to the store and reloads', () => {
    const { component, store, api } = setup();
    component.ngOnInit();
    api.list.mockClear();
    component.markAll();
    expect(store.markAll).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalled();
  });

  it('maps severity to a STATIC i18n key (no dynamic key building)', () => {
    const { component } = setup();
    expect(component.severityKey('critical')).toBe('notifications.severity.critical');
    expect(component.severityKey('info')).toBe('notifications.severity.info');
  });

  it('maps a type to a static label key + icon (BE enum values, with an unknown-type fallback)', () => {
    const { component } = setup();
    // BE NotificationType enum values → static i18n keys + icons.
    expect(component.typeKey('CUSTOMER_EVENT')).toBe('notifications.type.customerEvent');
    expect(component.typeIcon('SYSTEM')).toBe('ri-information-line');
    // An unknown/forward-compatible type falls back to the generic key/icon rather than crashing.
    expect(component.typeKey('BRAND_NEW_TYPE')).toBe('notifications.type.activity');
    expect(component.typeIcon('BRAND_NEW_TYPE')).toBe('ri-notification-3-line');
  });

  it('maps each notification TYPE to a category-tile hue (account/security → blue, unknown → blue)', () => {
    const { component } = setup();
    expect(component.typeTile('SECURITY_ALERT')).toBe('notif-row__tile--blue');
    expect(component.typeTile('ACCOUNT')).toBe('notif-row__tile--blue');
    expect(component.typeTile('KYC_EVENT')).toBe('notif-row__tile--teal');
    expect(component.typeTile('CUSTOMER_EVENT')).toBe('notif-row__tile--pink');
    expect(component.typeTile('SYSTEM')).toBe('notif-row__tile--yellow');
    // Forward-compatible: an out-of-union type degrades to the blue family, never undefined.
    expect(component.typeTile('BRAND_NEW_TYPE')).toBe('notif-row__tile--blue');

    // The severity badge keeps its own icon (icon + label, never colour-only).
    expect(component.severityIcon('critical')).toBe('ri-error-warning-line');
    expect(component.severityIcon('success')).toBe('ri-checkbox-circle-line');
  });

  it('re-exports the shared store unreadCount signal for the summary head + mark-all guard', () => {
    const { component, unreadCount } = setup({ unread: 3 });
    expect(component.unreadCount()).toBe(3);
    // Same signal instance — a store change is reflected without a second copy.
    unreadCount.set(0);
    expect(component.unreadCount()).toBe(0);
  });

  it('buckets the current page into today/earlier, emitting only non-empty groups in server order', () => {
    const now = new Date();
    const earlierIso = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { component } = setup({
      list: of(
        pageOf({
          data: [
            row({ id: 'a', createdAt: now.toISOString() }),
            row({ id: 'b', createdAt: earlierIso }),
            row({ id: 'c', createdAt: now.toISOString() }),
          ] as never,
          page: { page: 1, pageSize: 15, total: 3 },
        }),
      ),
    });
    component.ngOnInit();
    const groups = component.groups();
    expect(groups.map(g => g.key)).toEqual(['today', 'earlier']);
    expect(groups[0].labelKey).toBe('notifications.group.today');
    expect(groups[1].labelKey).toBe('notifications.group.earlier');
    // Server order is preserved within each bucket (a before c).
    expect(groups[0].items.map(n => n.id)).toEqual(['a', 'c']);
    expect(groups[1].items.map(n => n.id)).toEqual(['b']);
  });

  it('degrades to a single group when every row is in one bucket', () => {
    const now = new Date().toISOString();
    const { component } = setup({
      list: of(
        pageOf({
          data: [row({ id: 'a', createdAt: now }), row({ id: 'b', createdAt: now })] as never,
          page: { page: 1, pageSize: 15, total: 2 },
        }),
      ),
    });
    component.ngOnInit();
    const groups = component.groups();
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe('today');
    expect(groups[0].items.length).toBe(2);
  });

  it('an unparseable createdAt buckets into "earlier" (isToday guard returns false)', () => {
    const { component } = setup({
      list: of(
        pageOf({
          data: [row({ id: 'bad', createdAt: 'not-a-date' })] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    const groups = component.groups();
    expect(groups.map(g => g.key)).toEqual(['earlier']);
  });

  it('the read-state segmented maps "read" and any other value back to the typed control', () => {
    const { component } = setup();
    component.ngOnInit();
    component.onReadChange('read');
    expect(component.readControl.value).toBe('read');
    // Any unrecognised value collapses to the default 'all'.
    component.onReadChange('whatever');
    expect(component.readControl.value).toBe('all');
  });

  it('the "read" filter sends read:true as a server query param', () => {
    const { component, api } = setup();
    component.ngOnInit();
    api.list.mockClear();
    component.onReadChange('read');
    expect(api.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 15, read: true });
  });

  it('mark-read via the row control stops propagation and is a no-op when already marking / already read', () => {
    const { component, api } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    component.ngOnInit();
    const stopPropagation = vi.fn();
    // stop=true → the event's propagation is stopped so the row-click doesn't also fire.
    component.markRead(component.items()[0], true, { stopPropagation } as unknown as Event);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(api.markRead).toHaveBeenCalledTimes(1);

    // A second call while the (already-flipped) row is read is ignored — no duplicate API call.
    api.markRead.mockClear();
    component.markRead(component.items()[0], false);
    expect(api.markRead).not.toHaveBeenCalled();
  });

  it('a row with a customer resource exposes a route + opens the record without bubbling', () => {
    const { component, router } = setup({
      list: of(pageOf({ data: [row()] as never, page: { page: 1, pageSize: 15, total: 1 } })),
    });
    component.ngOnInit();
    const item = component.items()[0];
    expect(component.hasRoute(item)).toBe(true);

    const stopPropagation = vi.fn();
    component.openRecord(item, { stopPropagation } as unknown as Event);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/customers', 'c-1'], undefined);
  });

  it('a row with no navigable subject has no route and openRecord does not navigate', () => {
    const { component, router } = setup({
      list: of(
        pageOf({
          data: [row({ resourceType: null, resourceId: null })] as never,
          page: { page: 1, pageSize: 15, total: 1 },
        }),
      ),
    });
    component.ngOnInit();
    const item = component.items()[0];
    expect(component.hasRoute(item)).toBe(false);
    component.openRecord(item, { stopPropagation: vi.fn() } as unknown as Event);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('presentation helpers resolve relative-time + title/body text (with BE-key fallbacks)', () => {
    // A translate stub that echoes an unknown key (ngx-translate behaviour) exercises the fallback path.
    const i18n = {
      instant: (key: string) =>
        key === 'notifications.title.kyc'
          ? 'KYC changed'
          : key === 'notifications.body.kyc'
            ? 'Details here'
            : key === 'notifications.fallback.title'
              ? 'New notification'
              : key === 'notifications.fallback.body'
                ? 'You have a new notification.'
                : key,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: NotificationApi,
          useValue: {
            list: vi.fn(() => of(pageOf())),
            markRead: vi.fn(() => of(0)),
            markAll: vi.fn(() => of(0)),
          },
        },
        {
          provide: NotificationStore,
          useValue: { refresh: vi.fn(), markAll: vi.fn(), unreadCount: signal(0) },
        },
        {
          provide: DashboardStreamService,
          useValue: { connectNotifications: vi.fn(() => new Subject<unknown>().asObservable()) },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: TranslateService, useValue: i18n },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new NotificationsComponent());

    // relativeTime key for a just-now timestamp.
    expect(component.time(new Date().toISOString()).key).toBe('common.time.justNow');
    // Present BE keys resolve to their text.
    const present = {
      titleKey: 'notifications.title.kyc',
      bodyKey: 'notifications.body.kyc',
      params: null,
    } as never;
    expect(component.title(present)).toBe('KYC changed');
    expect(component.body(present)).toBe('Details here');
    // Missing BE keys → the generic FE fallback copy.
    const missing = {
      titleKey: 'notifications.title.x',
      bodyKey: 'notifications.body.x',
      params: null,
    } as never;
    expect(component.title(missing)).toBe('New notification');
    expect(component.body(missing)).toBe('You have a new notification.');
  });

  it('severity maps fall back safely for an out-of-union value (key/icon)', () => {
    const { component } = setup();
    expect(component.severityKey('mystery' as never)).toBe('notifications.severity.info');
    expect(component.severityIcon('mystery' as never)).toBe('ri-information-line');
  });
});
