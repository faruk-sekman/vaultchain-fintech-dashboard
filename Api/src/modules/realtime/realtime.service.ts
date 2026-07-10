/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Realtime event bus (SSE). A local RxJS Subject fans dashboard-relevant mutations out to SSE clients
 * connected to THIS instance. Most payloads carry only a customer id + type + server timestamp (NO
 * PII): clients react by re-fetching the masked aggregates.
 *
 * RECIPIENT SCOPING (security gate): the bus is a SINGLE Subject, but events split into
 * two delivery classes by the optional `recipientUserId` field:
 *   - BROADCAST (customer.* — `recipientUserId` absent): every connected stream receives it, exactly
 *     as before.
 *   - PRIVATE (notification.created — `recipientUserId` set): delivered ONLY to a stream whose
 *     authenticated subject matches that id. The per-subscriber filter in `scopedStream()` is the
 *     SERVER-SIDE security boundary — a user can never observe another user's notification event
 *     (FE filtering is NOT a security control). The scope travels INSIDE the event, so it is preserved
 *     across the Redis bridge in a multi-instance deployment.
 *
 * Horizontal-scale bridge (audit D-14), OPT-IN on `REDIS_URL`:
 *   - UNSET → single-process only, exactly as before (no Redis client injected → null).
 *   - set   → emit() ALSO publishes to a Redis channel, and a duplicated subscriber connection feeds
 *     REMOTE events into the same local Subject, so an SSE client on any instance sees a mutation that
 *     happened on any other instance. The local Subject is kept for same-instance delivery (lowest
 *     latency, and the only path when Redis is down); an `originId` envelope drops this instance's own
 *     echo so a same-instance event is delivered exactly once.
 */
import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { Observable, Subject, filter } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { REALTIME_CHANNEL, REDIS_CLIENT } from '../../infrastructure/redis/redis.constants';

export type DashboardEventType =
  | 'customer.created'
  | 'customer.updated'
  | 'customer.deleted'
  // A notification was created for a SPECIFIC recipient. Unlike the customer.* events
  // (broadcast — every dashboard re-fetches masked aggregates), this event carries `recipientUserId`
  // and is delivered ONLY to that recipient's stream (server-side scoping — see `scopedStream`).
  | 'notification.created';

export interface DashboardEvent {
  type: DashboardEventType;
  /** The affected customer id (a UUID — not PII). For notification.created this is the notification id. */
  customerId: string;
  /** ISO server timestamp of when the change committed. */
  at: string;
  /**
   * RECIPIENT SCOPE (security gate). When set, the event is PRIVATE to this user id: the
   * SSE controller delivers it ONLY to a stream whose authenticated subject matches — never to other
   * connected clients. When absent (the customer.* default) the event is a broadcast, exactly as
   * before. The bus stays a single Subject; the per-subscriber filter in `scopedStream` is the
   * security boundary (NOT FE filtering). The id is a UUID — not PII. Preserved across the Redis bridge
   * (it travels inside the same event envelope), so scoping holds in a multi-instance deployment.
   */
  recipientUserId?: string;
}

/** Cross-instance wire envelope on the Redis channel: the event plus the origin instance id. */
interface RealtimeEnvelope {
  originId: string;
  event: DashboardEvent;
}

/**
 * Runtime allowlist of the event types accepted from a REMOTE (Redis) publisher. `satisfies` fails the
 * build if an entry drifts from DashboardEventType.
 */
const REMOTE_EVENT_TYPES = new Set<DashboardEventType>(
  ['customer.created', 'customer.updated', 'customer.deleted', 'notification.created'] satisfies DashboardEventType[],
);

/**
 * Allowlist schema guard for a REMOTE envelope (F18 — message-boundary trust). The Redis channel is a
 * trust boundary: a forged/buggy publisher must not inject an event with an unknown type, nor smuggle a
 * private event past recipient scoping by malforming `recipientUserId`. Only a fully-shaped envelope is
 * accepted — anything else is dropped.
 */
function isValidRemoteEnvelope(value: unknown): value is RealtimeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Record<string, unknown>;
  if (typeof env.originId !== 'string') return false;
  if (typeof env.event !== 'object' || env.event === null) return false;
  const ev = env.event as Record<string, unknown>;
  return (
    typeof ev.type === 'string' &&
    REMOTE_EVENT_TYPES.has(ev.type as DashboardEventType) &&
    typeof ev.customerId === 'string' &&
    typeof ev.at === 'string' &&
    (ev.recipientUserId === undefined || typeof ev.recipientUserId === 'string')
  );
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<DashboardEvent>();
  /** Per-process id so the Redis subscriber can drop this instance's own published echo. */
  private readonly originId = randomUUID();
  /** Dedicated subscriber connection (ioredis requires a connection in subscriber mode). */
  private subscriber: Redis | null = null;

  // @Optional so `new RealtimeService()` (unit tests) and the Redis-disabled path both work: the
  // token resolves to `null` when `REDIS_URL` is unset.
  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null) {}

  /**
   * Hot stream of ALL dashboard events. Use this only for BROADCAST consumers; recipient-scoped
   * consumers MUST use `scopedStream(subjectUserId)` so private notification.created events are
   * filtered server-side. (Retained for the broadcast customer.* dashboard path + unit coverage.)
   */
  readonly stream$: Observable<DashboardEvent> = this.events.asObservable();

  /**
   * A per-subscriber view of the bus for one authenticated SSE subject (security gate).
   * Delivers:
   *   - every BROADCAST event (no `recipientUserId`) — e.g. customer.created/updated/deleted, and
   *   - PRIVATE events whose `recipientUserId` equals `subjectUserId` — e.g. this user's
   *     notification.created.
   * A private event addressed to a DIFFERENT user is dropped here, before it ever reaches the SSE
   * writer. This is the server-side enforcement that user A never receives user B's notification.
   */
  scopedStream(subjectUserId: string): Observable<DashboardEvent> {
    return this.events.asObservable().pipe(
      filter((event) => event.recipientUserId === undefined || event.recipientUserId === subjectUserId),
    );
  }

  /** Publish a committed BROADCAST mutation to every connected dashboard. Call AFTER the tx commits. */
  emit(type: DashboardEventType, customerId: string): void;
  /**
   * Publish a committed RECIPIENT-SCOPED event (notification.created): delivered ONLY to the
   * recipient's own stream. `customerId` carries the entity id (the notification id); `options`
   * carries the recipient subject the event is private to.
   */
  emit(type: DashboardEventType, customerId: string, options: ScopedEmitOptions): void;
  emit(type: DashboardEventType, customerId: string, options?: ScopedEmitOptions): void {
    const event: DashboardEvent = {
      type,
      customerId,
      at: new Date().toISOString(),
      ...(options?.recipientUserId ? { recipientUserId: options.recipientUserId } : {}),
    };
    // Same-instance delivery (always, even with Redis down).
    this.events.next(event);
    // Cross-instance fan-out (best-effort; a publish failure never breaks the local emit).
    if (this.redis) {
      const envelope: RealtimeEnvelope = { originId: this.originId, event };
      void this.redis.publish(REALTIME_CHANNEL, JSON.stringify(envelope)).catch((err: unknown) => {
        this.logger.warn(`Realtime publish failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      });
    }
  }

  onModuleInit(): void {
    if (!this.redis) return; // single-process: no bridge.
    // A subscriber connection cannot also issue normal commands, so duplicate the shared client.
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('error', (err: Error) => this.logger.warn(`Realtime subscriber error: ${err.message}`));
    this.subscriber.on('message', (_channel: string, raw: string) => this.onRemoteMessage(raw));
    void this.subscriber.subscribe(REALTIME_CHANNEL).catch((err: unknown) => {
      this.logger.warn(`Realtime subscribe failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.quit();
    } catch {
      this.subscriber.disconnect();
    }
    this.subscriber = null;
  }

  /** Feed a REMOTE event into the local Subject, dropping this instance's own echo. */
  private onRemoteMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // ignore malformed JSON — never throw on the subscriber callback.
    }
    // Allowlist schema guard (F18): only a fully-shaped envelope from ANOTHER instance is accepted, so a
    // forged/unknown-shape event can never reach the SSE bus or weaken recipient scoping.
    if (!isValidRemoteEnvelope(parsed) || parsed.originId === this.originId) return; // drop junk / our own echo.
    // Rebuild the event from ONLY the allowlisted fields (no extra-field smuggling). It keeps its
    // `recipientUserId`, so scoping is preserved across instances (scopedStream still drops a private
    // event addressed to a different subject).
    const { type, customerId, at, recipientUserId } = parsed.event;
    this.events.next({ type, customerId, at, ...(recipientUserId !== undefined ? { recipientUserId } : {}) });
  }
}

/** Options for a recipient-scoped emit (notification.created). */
export interface ScopedEmitOptions {
  /** The user id the event is private to. Only this subject's SSE stream receives it. */
  recipientUserId: string;
}
