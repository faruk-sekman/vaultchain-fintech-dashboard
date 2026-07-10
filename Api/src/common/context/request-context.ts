/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * SEC-003 per-request context: a Node AsyncLocalStorage carrying the authenticated operator id so the
 * database layer can publish it as the `app.user_id` GUC without threading it through every method
 * signature. Built-in `node:async_hooks` — NO new dependency. Populated per HTTP request by
 * OperatorContextInterceptor; read by `applyRlsContext` (rls-context.ts). Design:
 * docs/security/rls-app-connection-design.md.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** The authenticated operator's user id (JWT `sub`), or null on unauthenticated / system / background paths. */
  operatorId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` active for the entire async call tree beneath it. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current operator id, or null when no request context is active (system / background paths). */
export function currentOperatorId(): string | null {
  return storage.getStore()?.operatorId ?? null;
}
