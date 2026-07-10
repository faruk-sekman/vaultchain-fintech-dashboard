/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the shared NotificationStore: the one-time live init, the refresh mapping
 * (rows + unreadCount + loaded/hasUnread), mark-read / mark-all re-pulling, and the SSE-driven refresh.
 * NotificationApi + DashboardStreamService are stubbed at the seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NEVER, Observable, Subject, of, throwError } from 'rxjs';
import { NotificationApi, NotificationPage } from '@core/api/notification.api';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { NotificationStore } from './notification.store';

function pageOf(over: Partial<NotificationPage> = {}): NotificationPage {
  return {
    data: [],
    page: { page: 1, pageSize: 6, total: 0 },
    unreadCount: 0,
    ...over,
  };
}

function setup(opts: { list?: Observable<NotificationPage>; stream?: Subject<unknown> } = {}) {
  const stream$ = opts.stream ?? new Subject<unknown>();
  const api = {
    list: vi.fn(() => opts.list ?? of(pageOf())),
    markRead: vi.fn(() => of(undefined)),
    markAll: vi.fn(() => of(undefined)),
  };
  const stream = { connectNotifications: vi.fn(() => stream$.asObservable()) };
  TestBed.configureTestingModule({
    providers: [
      NotificationStore,
      { provide: NotificationApi, useValue: api },
      { provide: DashboardStreamService, useValue: stream },
    ],
  });
  const store = TestBed.inject(NotificationStore);
  return { store, api, stream, stream$ };
}

describe('NotificationStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('init() loads the head + subscribes to the SSE event exactly once', () => {
    const { store, api, stream } = setup();
    store.init();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(stream.connectNotifications).toHaveBeenCalledTimes(1);
    // A second init re-uses the feed (refresh only) — it does not re-subscribe.
    store.init();
    expect(stream.connectNotifications).toHaveBeenCalledTimes(1);
  });

  it('a re-entrant init() after the first load re-refreshes the badge (freshness on re-entry)', () => {
    // First init settles synchronously (of()), so `_loaded` is true; a second init takes the
    // already-loaded branch and re-pulls the head so the badge is fresh, without re-subscribing.
    const { store, api } = setup();
    store.init();
    expect(store.loaded()).toBe(true);
    api.list.mockClear();
    store.init();
    expect(api.list).toHaveBeenCalledTimes(1); // the re-entry refresh
  });

  it('init() is a no-op while the first load is still in flight (loading, not yet loaded)', () => {
    // A pending (never-settling) first load keeps `_loading` true and `_loaded` false, so a concurrent
    // init() re-entry hits neither the refresh nor a second subscribe — it just returns.
    const stream$ = new Subject<unknown>();
    const { store, api, stream } = setup({ list: NEVER as never, stream: stream$ });
    store.init();
    expect(store.loading()).toBe(true);
    expect(store.loaded()).toBe(false);
    expect(api.list).toHaveBeenCalledTimes(1);
    store.init(); // loading && !loaded → early return, no refresh, no re-subscribe
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(stream.connectNotifications).toHaveBeenCalledTimes(1);
  });

  it('refresh() maps rows + unreadCount and flips loaded', () => {
    const { store } = setup({
      list: of(
        pageOf({
          data: [{ id: 'n1' }] as never,
          page: { page: 1, pageSize: 6, total: 1 },
          unreadCount: 4,
        }),
      ),
    });
    store.refresh();
    expect(store.recent().length).toBe(1);
    expect(store.unreadCount()).toBe(4);
    expect(store.hasUnread()).toBe(true);
    expect(store.loaded()).toBe(true);
    expect(store.loading()).toBe(false);
  });

  it('a failed refresh leaves prior state intact and still flips loaded/loading', () => {
    const { store } = setup({ list: throwError(() => new Error('down')) });
    store.refresh();
    expect(store.recent()).toEqual([]);
    expect(store.unreadCount()).toBe(0);
    expect(store.loaded()).toBe(true);
    expect(store.loading()).toBe(false);
  });

  it('markRead() calls the API then re-pulls', () => {
    const { store, api } = setup();
    store.markRead('n1');
    expect(api.markRead).toHaveBeenCalledWith('n1');
    expect(api.list).toHaveBeenCalled(); // the post-mark refresh
  });

  it('markRead() swallows an API failure (catchError → EMPTY): no throw, no re-pull', () => {
    const { store, api } = setup();
    api.markRead.mockReturnValueOnce(throwError(() => new Error('nope')));
    api.list.mockClear();
    expect(() => store.markRead('n1')).not.toThrow();
    expect(api.markRead).toHaveBeenCalledWith('n1');
    // The error is swallowed before `next`, so the follow-up refresh never runs.
    expect(api.list).not.toHaveBeenCalled();
  });

  it('markAll() calls the API then re-pulls', () => {
    const { store, api } = setup();
    store.markAll();
    expect(api.markAll).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalled();
  });

  it('markAll() swallows an API failure (catchError → EMPTY): no throw, no re-pull', () => {
    const { store, api } = setup();
    api.markAll.mockReturnValueOnce(throwError(() => new Error('nope')));
    api.list.mockClear();
    expect(() => store.markAll()).not.toThrow();
    expect(api.markAll).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('an SSE notification.created event refreshes the feed (debounced)', () => {
    vi.useFakeTimers();
    const stream$ = new Subject<unknown>();
    const { store, api } = setup({ stream: stream$ });
    store.init();
    api.list.mockClear();
    // Real wire shape: the new notification id rides in `customerId` (the BE envelope's id slot).
    stream$.next({ type: 'notification.created', customerId: 'x', recipientUserId: 'me', at: 't' });
    vi.advanceTimersByTime(350);
    expect(api.list).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
