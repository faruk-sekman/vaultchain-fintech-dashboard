/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the SSE event bus. They pin the contract the dashboard depends on: emit() fans a
 * committed mutation out to every connected client, the broadcast payload carries ONLY a customer id +
 * type + ISO timestamp (NO PII), and the stream is hot. RECIPIENT SCOPING: a
 * notification.created emit carries `recipientUserId` and `scopedStream(subject)` delivers it ONLY to
 * the matching subject while still passing broadcast customer.* events to all — the server-side gate
 * that prevents user A from observing user B's notification. The Redis block pins the OPT-IN bridge
 * (audit D-14): emit also publishes cross-instance, remote events feed the local
 * stream, this instance's own echo is dropped (exactly-once same-instance delivery), and every Redis
 * failure path (subscribe/publish/quit) degrades quietly without breaking same-instance delivery.
 */
import { firstValueFrom } from 'rxjs';
import type Redis from 'ioredis';
import { RealtimeService, type DashboardEvent } from './realtime.service';

describe('RealtimeService', () => {
  it('emits a committed mutation to a subscribed client', async () => {
    const service = new RealtimeService();
    const next = firstValueFrom(service.stream$);

    service.emit('customer.created', 'cust-1');

    const event = await next;
    expect(event).toMatchObject({ type: 'customer.created', customerId: 'cust-1' });
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO timestamp
  });

  it('a broadcast customer event carries no PII and no recipient scope', async () => {
    const service = new RealtimeService();
    const next = firstValueFrom(service.stream$);

    service.emit('customer.updated', 'cust-2');

    const event = await next;
    // Broadcast events have exactly these keys — NO recipientUserId (so they reach everyone).
    expect(Object.keys(event).sort()).toEqual(['at', 'customerId', 'type']);
    expect(event.recipientUserId).toBeUndefined();
  });

  it('fans the same broadcast event out to every connected client (hot stream)', async () => {
    const service = new RealtimeService();
    const received: DashboardEvent[] = [];
    const a = service.stream$.subscribe((e) => received.push(e));
    const b = service.stream$.subscribe((e) => received.push(e));

    service.emit('customer.deleted', 'cust-3');

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.customerId === 'cust-3' && e.type === 'customer.deleted')).toBe(true);
    a.unsubscribe();
    b.unsubscribe();
  });

  it('does NOT publish to Redis when no client is injected (single-process default)', () => {
    // Constructed with the default null client → no Redis path at all.
    const service = new RealtimeService();
    expect(() => service.emit('customer.created', 'cust-x')).not.toThrow();
  });

  it('single-process: onModuleInit is a no-op (no bridge) and onModuleDestroy with no subscriber returns', async () => {
    // Exercises the `if (!this.redis) return` (init) + `if (!this.subscriber) return` (destroy) guards.
    const service = new RealtimeService(); // null client
    expect(() => service.onModuleInit()).not.toThrow();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('RealtimeService recipient scoping (security gate)', () => {
  it('a recipient-scoped emit stamps recipientUserId onto the event', async () => {
    const service = new RealtimeService();
    const next = firstValueFrom(service.stream$);

    service.emit('notification.created', 'notif-1', { recipientUserId: 'user-A' });

    const event = await next;
    expect(event).toMatchObject({ type: 'notification.created', customerId: 'notif-1', recipientUserId: 'user-A' });
  });

  it('scopedStream(A) RECEIVES a notification addressed to A', async () => {
    const service = new RealtimeService();
    const received: DashboardEvent[] = [];
    const sub = service.scopedStream('user-A').subscribe((e) => received.push(e));

    service.emit('notification.created', 'notif-A', { recipientUserId: 'user-A' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ customerId: 'notif-A', recipientUserId: 'user-A' });
    sub.unsubscribe();
  });

  it('scopedStream(A) DOES NOT receive a notification addressed to B (the negative gate)', () => {
    const service = new RealtimeService();
    const receivedByA: DashboardEvent[] = [];
    const receivedByB: DashboardEvent[] = [];
    const subA = service.scopedStream('user-A').subscribe((e) => receivedByA.push(e));
    const subB = service.scopedStream('user-B').subscribe((e) => receivedByB.push(e));

    service.emit('notification.created', 'notif-B', { recipientUserId: 'user-B' });

    expect(receivedByA).toHaveLength(0); // A must NEVER see B's private event
    expect(receivedByB).toHaveLength(1);
    expect(receivedByB[0].customerId).toBe('notif-B');
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it('scopedStream still delivers BROADCAST customer.* events to every subject', () => {
    const service = new RealtimeService();
    const receivedByA: DashboardEvent[] = [];
    const receivedByB: DashboardEvent[] = [];
    const subA = service.scopedStream('user-A').subscribe((e) => receivedByA.push(e));
    const subB = service.scopedStream('user-B').subscribe((e) => receivedByB.push(e));

    service.emit('customer.updated', 'cust-shared'); // no recipient → broadcast

    expect(receivedByA).toHaveLength(1);
    expect(receivedByB).toHaveLength(1);
    subA.unsubscribe();
    subB.unsubscribe();
  });
});

describe('RealtimeService (Redis bridge)', () => {
  type AsyncImpl = (...args: unknown[]) => Promise<unknown>;

  /** Minimal ioredis double: captures publish + the subscriber's `message`/`error` handlers. */
  function makeRedis(
    over: { subscribeImpl?: AsyncImpl; publishImpl?: AsyncImpl; quitImpl?: AsyncImpl } = {},
  ) {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const subscribe: AsyncImpl = over.subscribeImpl ?? (() => Promise.resolve(1));
    const quit: AsyncImpl = over.quitImpl ?? (() => Promise.resolve('OK'));
    const publishImpl: AsyncImpl = over.publishImpl ?? (() => Promise.resolve(1));
    const subscriber = {
      on: jest.fn((evt: string, cb: (...args: unknown[]) => void) => {
        handlers[evt] = cb;
      }),
      subscribe: jest.fn(subscribe),
      quit: jest.fn(quit),
      disconnect: jest.fn(),
    };
    const publish = jest.fn(publishImpl);
    const client = { duplicate: jest.fn(() => subscriber), publish };
    return {
      client: client as unknown as Redis,
      subscriber,
      publish,
      emitMessage: (raw: string) => handlers.message?.('ch', raw),
      emitError: (err: unknown) => handlers.error?.(err),
    };
  }

  it('publishes the event cross-instance AND delivers it locally', async () => {
    const { client, publish } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const next = firstValueFrom(service.stream$);

    service.emit('customer.created', 'cust-7');

    await expect(next).resolves.toMatchObject({ type: 'customer.created', customerId: 'cust-7' });
    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = publish.mock.calls[0];
    expect(channel).toBe('ftd:realtime:dashboard');
    expect(JSON.parse(payload as string)).toMatchObject({
      originId: expect.any(String),
      event: { type: 'customer.created', customerId: 'cust-7' },
    });
    await service.onModuleDestroy();
  });

  it('a recipient-scoped emit carries recipientUserId across the Redis publish (scope preserved)', async () => {
    const { client, publish } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();

    service.emit('notification.created', 'notif-x', { recipientUserId: 'user-A' });

    const [, payload] = publish.mock.calls[0];
    expect(JSON.parse(payload as string)).toMatchObject({
      event: { type: 'notification.created', customerId: 'notif-x', recipientUserId: 'user-A' },
    });
    await service.onModuleDestroy();
  });

  it('a REMOTE recipient-scoped event keeps its scope: scopedStream(B) drops a remote event for A', async () => {
    const { client, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const receivedByB: DashboardEvent[] = [];
    const subB = service.scopedStream('user-B').subscribe((e) => receivedByB.push(e));

    emitMessage(
      JSON.stringify({
        originId: 'other-instance',
        event: { type: 'notification.created', customerId: 'notif-A', at: '2026-01-01T00:00:00.000Z', recipientUserId: 'user-A' },
      }),
    );

    expect(receivedByB).toHaveLength(0); // scope holds across the bridge
    subB.unsubscribe();
    await service.onModuleDestroy();
  });

  it('feeds a REMOTE event (different originId) into the local stream', async () => {
    const { client, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const next = firstValueFrom(service.stream$);

    emitMessage(
      JSON.stringify({
        originId: 'other-instance',
        event: { type: 'customer.updated', customerId: 'cust-9', at: '2026-01-01T00:00:00.000Z' },
      }),
    );

    await expect(next).resolves.toMatchObject({ type: 'customer.updated', customerId: 'cust-9' });
    await service.onModuleDestroy();
  });

  it("drops this instance's own echo so a same-instance event is delivered exactly once", async () => {
    const { client, publish, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const received: DashboardEvent[] = [];
    const sub = service.stream$.subscribe((e) => received.push(e));

    service.emit('customer.deleted', 'cust-1');
    // Simulate the broker echoing our own publish back to our own subscriber — it must be dropped.
    const ownEnvelope = publish.mock.calls[0][1] as string;
    emitMessage(ownEnvelope);

    expect(received).toHaveLength(1);
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('ignores malformed subscriber payloads without throwing', async () => {
    const { client, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const received: DashboardEvent[] = [];
    const sub = service.stream$.subscribe((e) => received.push(e));

    expect(() => emitMessage('{not json')).not.toThrow();
    expect(received).toHaveLength(0);
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('drops every malformed/forged REMOTE envelope shape (allowlist guard, F18)', async () => {
    const { client, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const received: DashboardEvent[] = [];
    const sub = service.stream$.subscribe((e) => received.push(e));

    const forged: string[] = [
      '42', // not an object
      'null', // null
      JSON.stringify({ hello: 'world' }), // no originId
      JSON.stringify({ originId: 7, event: { type: 'customer.created', customerId: 'c', at: 't' } }), // originId not a string
      JSON.stringify({ originId: 'o', event: 'nope' }), // event not an object
      JSON.stringify({ originId: 'o', event: null }), // event is null
      JSON.stringify({ originId: 'o', event: { type: 5, customerId: 'c', at: 't' } }), // type not a string
      JSON.stringify({ originId: 'o', event: { type: 'customer.wiped', customerId: 'c', at: 't' } }), // type outside allowlist
      JSON.stringify({ originId: 'o', event: { type: 'customer.created', at: 't' } }), // missing customerId
      JSON.stringify({ originId: 'o', event: { type: 'customer.created', customerId: 'c' } }), // missing at
      JSON.stringify({ originId: 'o', event: { type: 'notification.created', customerId: 'n', at: 't', recipientUserId: 42 } }), // recipientUserId not a string (scope-smuggle attempt)
    ];
    for (const raw of forged) expect(() => emitMessage(raw)).not.toThrow();

    expect(received).toHaveLength(0); // every forged/malformed event was dropped at the trust boundary
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('accepts a well-formed REMOTE event but strips extra smuggled fields (F18)', async () => {
    const { client, emitMessage } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    const next = firstValueFrom(service.stream$);

    emitMessage(
      '{"originId":"other","event":{"type":"customer.updated","customerId":"cust-ok","at":"2026-01-01T00:00:00.000Z","evil":"x"}}',
    );

    const event = await next;
    expect(Object.keys(event).sort()).toEqual(['at', 'customerId', 'type']); // only allowlisted fields survive
    expect((event as unknown as Record<string, unknown>)['evil']).toBeUndefined();
    await service.onModuleDestroy();
  });

  it('logs (does not throw) when the subscriber emits a transport error', async () => {
    const { client, emitError } = makeRedis();
    const service = new RealtimeService(client);
    service.onModuleInit();
    // The registered `error` handler must swallow the error (warn-only), never crash the process.
    expect(() => emitError(new Error('subscriber socket reset'))).not.toThrow();
    await service.onModuleDestroy();
  });

  it('survives a failed channel subscribe (Error and non-Error rejections) without throwing', async () => {
    // Error rejection → `err.message`; the `?? 'unknown error'` arm is hit by the non-Error case below.
    const a = makeRedis({ subscribeImpl: () => Promise.reject(new Error('NOAUTH')) });
    const svcA = new RealtimeService(a.client);
    expect(() => svcA.onModuleInit()).not.toThrow();

    const b = makeRedis({ subscribeImpl: () => Promise.reject('plain-string-failure') });
    const svcB = new RealtimeService(b.client);
    expect(() => svcB.onModuleInit()).not.toThrow();

    // Let the rejected subscribe promises settle so their `.catch` handlers run before assertions end.
    await Promise.resolve();
    await Promise.resolve();
    await svcA.onModuleDestroy();
    await svcB.onModuleDestroy();
  });

  it('a publish failure (Error and non-Error) never breaks same-instance delivery', async () => {
    // Error rejection exercises `err.message`; the non-Error rejection exercises the `'unknown error'` arm.
    const errCase = makeRedis({ publishImpl: () => Promise.reject(new Error('LOADING')) });
    const svc1 = new RealtimeService(errCase.client);
    svc1.onModuleInit();
    const local1 = firstValueFrom(svc1.stream$);
    svc1.emit('customer.created', 'cust-e'); // local emit must still fire despite the publish reject
    await expect(local1).resolves.toMatchObject({ customerId: 'cust-e' });

    const nonErrCase = makeRedis({ publishImpl: () => Promise.reject('boom') });
    const svc2 = new RealtimeService(nonErrCase.client);
    svc2.onModuleInit();
    const local2 = firstValueFrom(svc2.stream$);
    svc2.emit('customer.updated', 'cust-n');
    await expect(local2).resolves.toMatchObject({ customerId: 'cust-n' });

    await Promise.resolve();
    await Promise.resolve();
    await svc1.onModuleDestroy();
    await svc2.onModuleDestroy();
  });

  it('onModuleDestroy falls back to disconnect() when quit() rejects', async () => {
    // The graceful `quit()` can reject mid-shutdown; the catch must hard `disconnect()` so we never leak
    // a connection or throw out of the lifecycle hook.
    const { client, subscriber } = makeRedis({ quitImpl: () => Promise.reject(new Error('already closing')) });
    const service = new RealtimeService(client);
    service.onModuleInit();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(subscriber.quit).toHaveBeenCalled();
    expect(subscriber.disconnect).toHaveBeenCalled(); // the catch path
  });
});
