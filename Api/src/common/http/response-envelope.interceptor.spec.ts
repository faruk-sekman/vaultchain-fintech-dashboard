/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for ResponseEnvelopeInterceptor. Covers: wrapping a bare payload in
 * { data, meta }, the correlationId-from-header vs generated branch, the already-enveloped
 * (paginated `{ data, page }`) pass-through with meta merge, null/primitive payloads, and the
 * SSE (text/event-stream) bypass. Hermetic: ExecutionContext + CallHandler mocked; rxjs of().
 */
import { CallHandler, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { firstValueFrom, of } from 'rxjs';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

function contextWith(headers: FastifyRequest['headers']): ExecutionContext {
  const request = { headers } as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function handlerOf(payload: unknown): CallHandler {
  return { handle: () => of(payload) } as CallHandler;
}

describe('ResponseEnvelopeInterceptor', () => {
  const interceptor = new ResponseEnvelopeInterceptor();

  it('wraps a bare object in { data, meta } and echoes the x-correlation-id header', async () => {
    const ctx = contextWith({ 'x-correlation-id': 'corr-9' });
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf({ id: 1, name: 'Ada' })));

    expect(result).toEqual({ data: { id: 1, name: 'Ada' }, meta: { correlationId: 'corr-9' } });
  });

  it('generates a correlationId when no header is supplied', async () => {
    const ctx = contextWith({});
    const result = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf({ ok: true })),
    )) as { data: unknown; meta: { correlationId: string } };

    expect(result.data).toEqual({ ok: true });
    // A UUID-shaped, non-empty correlationId was minted.
    expect(result.meta.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('uses the first value when x-correlation-id arrives as an array header', async () => {
    const ctx = contextWith({ 'x-correlation-id': ['first-id', 'second-id'] });
    const result = (await firstValueFrom(
      interceptor.intercept(ctx, handlerOf({ ok: true })),
    )) as { meta: { correlationId: string } };

    expect(result.meta.correlationId).toBe('first-id');
  });

  it('does NOT double-wrap an already-enveloped paginated payload; merges meta', async () => {
    const ctx = contextWith({ 'x-correlation-id': 'corr-list' });
    const paginated = { data: [{ id: 1 }], page: { total: 1, size: 20 } };
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(paginated)));

    expect(result).toEqual({
      data: [{ id: 1 }],
      page: { total: 1, size: 20 },
      meta: { correlationId: 'corr-list' },
    });
  });

  it('preserves an existing meta on an already-enveloped payload (existing wins on key clash)', async () => {
    const ctx = contextWith({ 'x-correlation-id': 'header-id' });
    const payload = { data: [], meta: { correlationId: 'payload-id', extra: 'kept' } };
    const result = (await firstValueFrom(interceptor.intercept(ctx, handlerOf(payload)))) as {
      meta: { correlationId: string; extra: string };
    };

    // The interceptor spreads ...meta then ...existing.meta, so the payload's meta overrides.
    expect(result.meta.correlationId).toBe('payload-id');
    expect(result.meta.extra).toBe('kept');
  });

  it('wraps a null payload as { data: null, meta }', async () => {
    const ctx = contextWith({ 'x-correlation-id': 'corr-null' });
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(null)));

    expect(result).toEqual({ data: null, meta: { correlationId: 'corr-null' } });
  });

  it('wraps a primitive (string) payload as data', async () => {
    const ctx = contextWith({ 'x-correlation-id': 'corr-str' });
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf('pong')));

    expect(result).toEqual({ data: 'pong', meta: { correlationId: 'corr-str' } });
  });

  it('bypasses enveloping entirely for an SSE (text/event-stream) request', async () => {
    const ctx = contextWith({ accept: 'text/event-stream' });
    const raw = { data: 'event-payload' };
    const result = await firstValueFrom(interceptor.intercept(ctx, handlerOf(raw)));

    // Raw MessageEvent framing passes through untouched (no meta added).
    expect(result).toBe(raw);
  });
});
