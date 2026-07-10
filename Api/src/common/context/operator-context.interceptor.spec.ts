/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the SEC-003 OperatorContextInterceptor: it runs the handler inside an ALS context
 * carrying request.user.sub, carries null when unauthenticated, and passes non-HTTP contexts through.
 */
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { OperatorContextInterceptor } from './operator-context.interceptor';
import { currentOperatorId } from './request-context';

const httpContext = (user?: { sub?: string }): ExecutionContext =>
  ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

/** A handler that records the operator id VISIBLE at the moment it runs (i.e. within the ALS scope). */
const recordingHandler = (sink: { seen: string | null }): CallHandler => ({
  handle: () => {
    sink.seen = currentOperatorId();
    return of('ok');
  },
});

describe('OperatorContextInterceptor (SEC-003)', () => {
  const interceptor = new OperatorContextInterceptor();

  it('runs the handler within an ALS context carrying request.user.sub', (done) => {
    const sink = { seen: 'unset' as string | null };
    interceptor.intercept(httpContext({ sub: 'op-42' }), recordingHandler(sink)).subscribe({
      next: (v) => expect(v).toBe('ok'),
      complete: () => {
        expect(sink.seen).toBe('op-42');
        done();
      },
    });
  });

  it('carries null for an unauthenticated request (no user)', (done) => {
    const sink = { seen: 'unset' as string | null };
    interceptor.intercept(httpContext(undefined), recordingHandler(sink)).subscribe({
      complete: () => {
        expect(sink.seen).toBeNull();
        done();
      },
    });
  });

  it('passes non-HTTP execution contexts straight through (no context established)', (done) => {
    const rpcCtx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const sink = { seen: 'unset' as string | null };
    interceptor.intercept(rpcCtx, recordingHandler(sink)).subscribe({
      complete: () => {
        expect(sink.seen).toBeNull(); // no ALS scope → currentOperatorId() is null
        done();
      },
    });
  });
});
