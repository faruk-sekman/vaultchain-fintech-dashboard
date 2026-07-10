/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * DashboardStreamService unit tests. Proves the SSE auth-transport fix:
 *   - the stream is AUTHORIZED first (POST /dashboard/stream-token, which sets the httpOnly cookie),
 *   - the EventSource URL carries NO token (no `?token=`, no JWT anywhere in the URL),
 *   - the EventSource is opened with `{ withCredentials: true }` so the browser replays the cookie,
 *   - the self-healing reconnect re-authorizes (a fresh cookie) on a dropped connection.
 * EventSource is stubbed (jsdom has none); each instance is captured so the test can assert the URL +
 * options and drive onmessage/onerror.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, take, toArray, firstValueFrom } from 'rxjs';
import { DashboardApi, DashboardEvent } from '@core/api/dashboard.api';
import { environment } from '../../../environments/environment';
import { DashboardStreamService, NotificationEvent } from './dashboard-stream.service';

/** Captures every EventSource the service constructs so a test can inspect/drive it. */
interface FakeEventSource {
  url: string;
  withCredentials: boolean;
  closed: boolean;
  onmessage: ((e: MessageEvent<string>) => void) | null;
  onerror: ((e: Event) => void) | null;
  listeners: Record<string, ((e: Event) => void)[]>;
}

let instances: FakeEventSource[] = [];

class EventSourceStub implements FakeEventSource {
  url: string;
  withCredentials: boolean;
  closed = false;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  listeners: Record<string, ((e: Event) => void)[]> = {};

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    instances.push(this);
  }

  addEventListener(type: string, handler: (e: Event) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  close(): void {
    this.closed = true;
  }
}

/** Fires the server's named `ping` keepalive event on a captured EventSource. */
function ping(source: FakeEventSource): void {
  source.listeners['ping']?.forEach(handler => handler(new Event('ping')));
}

describe('DashboardStreamService (SSE auth via httpOnly cookie)', () => {
  let api: { authorizeStream: ReturnType<typeof vi.fn> };
  let service: DashboardStreamService;

  beforeEach(() => {
    instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
    api = { authorizeStream: vi.fn(() => of(void 0)) };
    TestBed.configureTestingModule({
      providers: [DashboardStreamService, { provide: DashboardApi, useValue: api }],
    });
    service = TestBed.inject(DashboardStreamService);
  });

  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('authorizes the stream (sets the cookie) BEFORE opening the EventSource', () => {
    const sub = service.connect().subscribe();
    expect(api.authorizeStream).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);
    sub.unsubscribe();
  });

  it('opens the EventSource with NO token in the URL', () => {
    const sub = service.connect().subscribe();
    const url = instances[0].url;
    expect(url).toBe(`${environment.apiBaseUrl}/dashboard/stream`);
    // The whole point: no credential anywhere in the URL.
    expect(url).not.toContain('token');
    expect(url).not.toContain('?');
    sub.unsubscribe();
  });

  it('opens the EventSource with { withCredentials: true } so the browser sends the cookie', () => {
    const sub = service.connect().subscribe();
    expect(instances[0].withCredentials).toBe(true);
    sub.unsubscribe();
  });

  it('emits parsed DashboardEvents from onmessage frames', () => {
    const events: DashboardEvent[] = [];
    const sub = service.connect().subscribe(e => events.push(e));
    const payload: DashboardEvent = {
      type: 'customer.created',
      customerId: 'c1',
      at: '2026-06-18T00:00:00.000Z',
    };
    instances[0].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
    expect(events).toEqual([payload]);
    sub.unsubscribe();
  });

  it('ignores a malformed frame without tearing down the stream', () => {
    const events: DashboardEvent[] = [];
    const errSpy = vi.fn();
    const sub = service.connect().subscribe({ next: e => events.push(e), error: errSpy });
    instances[0].onmessage?.({ data: 'not-json{' } as MessageEvent<string>);
    expect(events).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  // --- The named `notification.created` event on the SAME socket -------------------
  /** Fire the named `notification.created` SSE event on a captured EventSource. */
  function fireNotification(source: FakeEventSource, payload: unknown): void {
    source.listeners['notification.created']?.forEach(handler =>
      handler({ data: JSON.stringify(payload) } as MessageEvent<string>),
    );
  }

  it('connectNotifications() emits parsed NotificationEvents from the named event', () => {
    const got: NotificationEvent[] = [];
    const sub = service.connectNotifications().subscribe(e => got.push(e));
    // Real wire shape: the BE reuses the `emit(type, customerId, { recipientUserId })`
    // envelope, so the new notification's id arrives in `customerId` (NOT a `notificationId` field).
    const payload: NotificationEvent = {
      type: 'notification.created',
      customerId: 'nf1',
      recipientUserId: 'u1',
      at: '2026-06-29T00:00:00.000Z',
    };
    fireNotification(instances[0], payload);
    expect(got).toEqual([payload]);
    sub.unsubscribe();
  });

  it('keeps the two streams separate: a customer frame is NOT seen by notification subscribers', () => {
    const customerEvents: DashboardEvent[] = [];
    const notificationEvents: NotificationEvent[] = [];
    const subA = service.connect().subscribe(e => customerEvents.push(e));
    const subB = service.connectNotifications().subscribe(e => notificationEvents.push(e));

    instances[0].onmessage?.({
      data: JSON.stringify({ type: 'customer.created', customerId: 'c1', at: 't' }),
    } as MessageEvent<string>);
    fireNotification(instances[0], {
      type: 'notification.created',
      customerId: 'nf1',
      recipientUserId: 'u1',
      at: 't',
    });

    expect(customerEvents).toHaveLength(1);
    expect(customerEvents[0].customerId).toBe('c1');
    expect(notificationEvents).toHaveLength(1);
    // The notification id rides in `customerId` (the BE envelope's id slot).
    expect(notificationEvents[0].customerId).toBe('nf1');
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it('ignores a malformed notification frame without tearing the stream down', () => {
    const got: NotificationEvent[] = [];
    const errSpy = vi.fn();
    const sub = service.connectNotifications().subscribe({ next: e => got.push(e), error: errSpy });
    instances[0].listeners['notification.created']?.forEach(handler =>
      handler({ data: 'not-json{' } as MessageEvent<string>),
    );
    expect(got).toHaveLength(0);
    expect(errSpy).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it('B8: the socket LINGERS through a route gap and closes only after the grace window', async () => {
    vi.useFakeTimers();
    const sub = service.connect().subscribe();
    expect(instances[0].closed).toBe(false);

    sub.unsubscribe();
    // Route churn: the last subscriber left, but the shared EventSource must survive a brief gap so
    // dashboard→customers→… navigation never re-mints a stream-token per screen.
    expect(instances[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(instances[0].closed).toBe(false);

    // Only a genuinely idle app (no listener for the full linger window) releases the socket.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(instances[0].closed).toBe(true);
    vi.useRealTimers();
  });

  it('B8: a resubscribe WITHIN the grace window reuses the live socket (no re-authorization)', async () => {
    vi.useFakeTimers();
    const sub = service.connect().subscribe();
    expect(api.authorizeStream).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(5_000); // a realistic navigation gap
    const sub2 = service.connect().subscribe();

    expect(api.authorizeStream).toHaveBeenCalledTimes(1); // SAME authorization + socket
    expect(instances).toHaveLength(1);
    expect(instances[0].closed).toBe(false);
    sub2.unsubscribe();
    vi.useRealTimers();
  });

  it('self-heals: on a dropped connection it RE-AUTHORIZES (fresh cookie) and reopens', async () => {
    // Fake timers so the retry's exponential backoff (timer(1000ms) on the first attempt) is advanced
    // deterministically instead of waiting ~1s of wall-clock.
    vi.useFakeTimers();
    // Collect the first event that arrives after a reconnect, proving the stream recovered.
    const received = firstValueFrom(service.connect().pipe(take(1), toArray()));

    // First connection drops before any event.
    expect(instances).toHaveLength(1);
    instances[0].onerror?.(new Event('error'));
    expect(instances[0].closed).toBe(true);

    // The outer retry re-runs `defer` after the backoff -> a second authorize + EventSource.
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(2);
    expect(api.authorizeStream).toHaveBeenCalledTimes(2);

    const payload: DashboardEvent = {
      type: 'customer.updated',
      customerId: 'c2',
      at: '2026-06-18T00:01:00.000Z',
    };
    instances[1].onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
    await expect(received).resolves.toEqual([payload]);
  });

  it('resets reconnect backoff after a healthy emission so the next drop reconnects fast (audit M4)', async () => {
    vi.useFakeTimers();
    const sub = service.connect().subscribe();

    // First drop with no prior event -> backoff attempt 1 = 1000ms, then reconnect (instances[1]).
    instances[0].onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(2);

    // Healthy period: instances[1] delivers an event -> resetOnSuccess resets the backoff counter.
    instances[1].onmessage?.({
      data: JSON.stringify({
        type: 'customer.created',
        customerId: 'c1',
        at: '2026-06-18T00:00:00.000Z',
      }),
    } as MessageEvent<string>);

    // Drop again. With the reset the next attempt is 1 (1000ms), NOT 2 (2000ms): advancing only 1000ms
    // must already yield the next reconnect — proving the backoff counter reset on the healthy emission.
    instances[1].onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances).toHaveLength(3);

    sub.unsubscribe();
  });

  it('multicasts: many subscribers share ONE EventSource and one authorization (audit)', () => {
    const sub1 = service.connect().subscribe();
    const sub2 = service.connect().subscribe();
    const sub3 = service.connect().subscribe();

    expect(api.authorizeStream).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);

    sub1.unsubscribe();
    sub2.unsubscribe();
    expect(instances[0].closed).toBe(false); // still one subscriber → socket stays open

    sub3.unsubscribe();
    // B8: the last unsubscribe no longer closes the shared socket immediately — it lingers for the
    // grace window (covered by the dedicated linger tests above).
    expect(instances[0].closed).toBe(false);
  });

  it('tears down a stalled stream when no frame arrives within the heartbeat window (audit)', async () => {
    vi.useFakeTimers();
    const sub = service.connect().subscribe();
    expect(instances).toHaveLength(1);

    // No event and no keepalive ping for the heartbeat window → watchdog fires → close + reconnect.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(instances[0].closed).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000); // the 1s reconnect backoff
    expect(instances).toHaveLength(2);
    expect(api.authorizeStream).toHaveBeenCalledTimes(2);

    sub.unsubscribe();
  });

  it('a keepalive ping resets the heartbeat watchdog (no spurious teardown)', async () => {
    vi.useFakeTimers();
    const sub = service.connect().subscribe();

    await vi.advanceTimersByTimeAsync(20_000); // almost to the window
    ping(instances[0]); // server keepalive re-arms the watchdog
    await vi.advanceTimersByTimeAsync(20_000); // 40s total, but only 20s since the ping

    expect(instances[0].closed).toBe(false);
    expect(instances).toHaveLength(1);

    sub.unsubscribe();
  });
});
