/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Wraps every successful response in the shared single-resource envelope
 * `{ data, meta: { correlationId } }` (api-design-guidelines). List
 * endpoints that already return `{ data, page }` are passed through unchanged.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface ResponseMeta {
  correlationId: string;
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // SSE streams must not be enveloped — let the raw text/event-stream MessageEvent framing through
    // untouched (otherwise each emitted event would be wrapped in { data, meta } and corrupt the feed).
    const accept = request.headers['accept'];
    if (typeof accept === 'string' && accept.includes('text/event-stream')) {
      return next.handle();
    }
    const header = request.headers['x-correlation-id'];
    const correlationId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
    const meta: ResponseMeta = { correlationId };

    return next.handle().pipe(
      map((payload) => {
        if (payload !== null && typeof payload === 'object' && 'data' in payload) {
          // Already enveloped (e.g. paginated list with `page`): merge meta, don't double-wrap.
          const existing = payload as Record<string, unknown>;
          return { ...existing, meta: { ...meta, ...(existing.meta as object | undefined) } };
        }
        return { data: payload, meta };
      }),
    );
  }
}
