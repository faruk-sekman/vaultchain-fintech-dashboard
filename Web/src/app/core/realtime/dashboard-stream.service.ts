/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dashboard realtime client (SSE). Authorizes the stream (POST /dashboard/stream-token, normal Bearer
 * auth) which sets a short-lived, minimally-scoped httpOnly cookie (`ftd_stream`), then opens an
 * EventSource with `withCredentials:true` so the browser replays that cookie on the handshake. NO
 * token is placed in the URL (a token in the URL leaks via access
 * logs, browser history, and the `Referer` header; the EventSource API cannot set an Authorization
 * header, but it DOES send cookies via `withCredentials`). Each emitted DashboardEvent is a PII-free
 * signal ({ type, customerId, at }); the dashboard reacts by re-fetching the masked aggregates. On any
 * drop the stream re-authorizes (fresh cookie) and reconnects with capped exponential backoff.
 *
 * The stream is MULTICAST (audit): the dashboard, analytics and customer-list all subscribe to the one
 * shared stream, so the browser opens ONE EventSource (and mints one stream-token) for the whole app
 * instead of one per screen. A client-side liveness watchdog tears down a half-open socket the browser
 * would otherwise leave hanging.
 */
import { Injectable, inject } from '@angular/core';
import { Observable, defer, filter, map, timer } from 'rxjs';
import { retry, share, switchMap } from 'rxjs/operators';
import { DashboardApi, DashboardEvent } from '@core/api/dashboard.api';
import { environment } from '../../../environments/environment';

/**
 * A recipient-scoped notification signal pushed over the SAME SSE stream as a NAMED `notification.created`
 * event. PII-free — like `DashboardEvent`, it carries only ids + a
 * timestamp; the client re-fetches the masked, BE-allowlisted notification rows. The BE scopes delivery
 * server-side (a user only ever receives their own), so this is not a client-side filter.
 *
 * Wire shape note: the BE reuses the realtime `emit(type, customerId, { recipientUserId })` envelope, so
 * the notification id arrives in `customerId` (NOT a `notificationId` field) and `type` is the literal
 * `'notification.created'`. The FE doesn't need the id here (it re-pulls the list head), but the type
 * matches the real payload exactly.
 */
export interface NotificationEvent {
  type: 'notification.created';
  /** The new notification's id (the BE puts the entity id in the envelope's `customerId` slot). */
  customerId: string;
  recipientUserId: string;
  at: string;
}

/**
 * Internal tagged union carried on the one EventSource: unnamed `message` frames are customer
 * `DashboardEvent`s; the named `notification.created` event is a `NotificationEvent`. `connect()` and
 * `connectNotifications()` each filter to one kind, so existing customer-event consumers are unchanged.
 */
type StreamFrame =
  | { kind: 'dashboard'; event: DashboardEvent }
  | { kind: 'notification'; event: NotificationEvent };

/** Reconnect backoff ceiling so a persistently-down API is retried at most every 15s. */
const MAX_BACKOFF_MS = 15_000;
/** Liveness window: the server pings every 25s, so 30s with NO frame means a half-open socket. */
const HEARTBEAT_TIMEOUT_MS = 30_000;
/** How long the shared EventSource lingers after its LAST subscriber leaves (route-gap grace, B8). */
const STREAM_LINGER_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class DashboardStreamService {
  private readonly api = inject(DashboardApi);

  /**
   * Single shared, self-healing stream. Subscribe to start (authorizes via the httpOnly cookie + opens
   * the EventSource); unsubscribe to stop. MULTICAST via `share` with refCount: N screens share ONE
   * EventSource; it closes when the last subscriber leaves and re-authorizes (a fresh cookie) for the
   * next. Reconnects transparently on drop / expiry / stalled heartbeat.
   */
  private readonly stream$ = defer(() => this.api.authorizeStream()).pipe(
    switchMap(() => this.openEventSource()),
    // EventSource's native auto-reconnect would reuse the now-expired cookie (-> 401); instead we close
    // on error and re-run from `defer` so the stream is RE-AUTHORIZED (fresh cookie) on each reconnect.
    retry({
      // resetOnSuccess: once a (re)connection delivers at least one event, reset the backoff counter so
      // the NEXT drop after a healthy period reconnects fast (1s) again, not the 15s ceiling (audit M4).
      resetOnSuccess: true,
      delay: (_error, attempt) => timer(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS)),
    }),
    // B8 (bugfix-backlog-2026-07): the socket outlives ROUTE churn. An immediate refCount-zero reset
    // would close + re-authorize (a fresh stream-token) whenever subscriber counts momentarily hit
    // zero between screen teardown/setup; the graced reset keeps the ONE EventSource through
    // navigation gaps and only closes after the app has genuinely had no listener for a while.
    share({ resetOnRefCountZero: () => timer(STREAM_LINGER_MS) }),
  );

  /** Customer-mutation signals (unnamed `message` frames). Unchanged contract for existing consumers. */
  connect(): Observable<DashboardEvent> {
    return this.stream$.pipe(
      filter(
        (frame): frame is { kind: 'dashboard'; event: DashboardEvent } =>
          frame.kind === 'dashboard',
      ),
      map(frame => frame.event),
    );
  }

  /**
   * Recipient-scoped `notification.created` signals (the named SSE event), for the live unread badge +
   * list. Shares the ONE authorized EventSource with {@link connect} (no second socket / stream-token).
   */
  connectNotifications(): Observable<NotificationEvent> {
    return this.stream$.pipe(
      filter(
        (frame): frame is { kind: 'notification'; event: NotificationEvent } =>
          frame.kind === 'notification',
      ),
      map(frame => frame.event),
    );
  }

  private openEventSource(): Observable<StreamFrame> {
    return new Observable<StreamFrame>(subscriber => {
      const url = `${environment.apiBaseUrl}/dashboard/stream`;
      // withCredentials: send the httpOnly `ftd_stream` cookie cross-origin on the handshake (and on
      // EventSource's own reconnects) — no token in the URL.
      const source = new EventSource(url, { withCredentials: true });

      // Liveness watchdog: a half-open connection (TCP alive, server gone) may never fire `onerror`, so
      // if NO frame — a real event OR the server's 25s keepalive ping — arrives within the window, tear
      // the socket down so the outer retry re-authorizes and reopens.
      let watchdog: ReturnType<typeof setTimeout>;
      const armWatchdog = (): void => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          source.close();
          subscriber.error(new Error('Dashboard stream heartbeat timed out'));
        }, HEARTBEAT_TIMEOUT_MS);
      };
      armWatchdog();

      source.onmessage = (event: MessageEvent<string>) => {
        armWatchdog();
        try {
          subscriber.next({ kind: 'dashboard', event: JSON.parse(event.data) as DashboardEvent });
        } catch {
          // Ignore a malformed frame rather than tearing down the whole stream.
        }
      };
      // The recipient-scoped notification signal arrives as a NAMED `notification.created` event (never
      // hits onmessage). Forward it as a notification frame (and reset the watchdog — it counts as
      // liveness); a malformed payload is ignored rather than tearing the stream down.
      source.addEventListener('notification.created', (event: Event) => {
        armWatchdog();
        try {
          const data = (event as MessageEvent<string>).data;
          subscriber.next({ kind: 'notification', event: JSON.parse(data) as NotificationEvent });
        } catch {
          // Ignore a malformed notification frame; the next list refresh self-heals the badge.
        }
      });
      // The server's keepalive is a NAMED `ping` event (never hits onmessage) — observe it only to
      // reset the watchdog, without surfacing it as a stream frame.
      source.addEventListener('ping', armWatchdog);

      source.onerror = () => {
        // Close so the browser doesn't silently retry with a now-stale cookie, then surface an error
        // so the outer retry() re-authorizes and reopens.
        clearTimeout(watchdog);
        source.close();
        subscriber.error(new Error('Dashboard stream connection lost'));
      };

      return () => {
        clearTimeout(watchdog);
        source.close();
      };
    });
  }
}
