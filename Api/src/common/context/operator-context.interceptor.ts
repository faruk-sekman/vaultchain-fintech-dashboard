/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * SEC-003 operator-context interceptor: establishes the per-request AsyncLocalStorage context carrying
 * the authenticated operator id (JWT `sub`). Runs in the interceptor phase — AFTER JwtAuthGuard has set
 * `request.user` — so the id is available; downstream DB writes read it via `applyRlsContext` to set the
 * `app.user_id` GUC. A pure passthrough: it changes no response and adds no dependency. Unauthenticated
 * requests get `operatorId: null`; non-HTTP execution contexts pass straight through.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithRequestContext } from './request-context';

@Injectable()
export class OperatorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{ user?: { sub?: string } }>();
    const operatorId = request.user?.sub ?? null;
    // Run the whole downstream (handler → service → DB) inside the ALS context so `currentOperatorId()`
    // resolves for any code path that reads it. Subscribing within `run` keeps the context active for
    // the async continuation (the documented ALS-with-RxJS pattern).
    return new Observable((subscriber) => {
      runWithRequestContext({ operatorId }, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
