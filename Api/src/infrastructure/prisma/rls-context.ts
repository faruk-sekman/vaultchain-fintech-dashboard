/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * SEC-003 per-request RLS preamble. `applyRlsContext` drops an OPEN transaction to exactly `app_rw` and
 * publishes the operator id as the `app.user_id` GUC — both transaction-local (`SET LOCAL` / `is_local`),
 * so they are pooling-safe (reset at COMMIT/ROLLBACK, never leak to the next request on a reused pooled
 * connection — the design's crux). Gated behind `DB_RLS_ENFORCED`: OFF by default → a no-op, so dev/CI
 * and any deployment not yet flipped to the `app_login` runtime role are completely unchanged. Design:
 * docs/security/rls-app-connection-design.md.
 */
import { Prisma } from '@prisma/client';
import { currentOperatorId } from '../../common/context/request-context';

/**
 * SEC-003 runtime enforcement flag. Read raw from the environment (mirrors THROTTLE_DISABLED) so the app
 * boots unconfigured. Turn ON only alongside the two-role topology (runtime `DATABASE_URL` = `app_login`)
 * — enabling it under the superuser dev/CI connection is harmless (RLS is bypassed for a superuser) but
 * pointless.
 */
export function isRlsEnforced(): boolean {
  return process.env.DB_RLS_ENFORCED === '1' || process.env.DB_RLS_ENFORCED === 'true';
}

/**
 * Sets the per-request role + operator GUC on an already-open transaction `tx`. MUST be the first
 * statement inside the `$transaction` callback so the preamble and the work share one connection. No-op
 * unless `DB_RLS_ENFORCED` is set. `operatorId` defaults to the AsyncLocalStorage request context
 * (OperatorContextInterceptor); write paths pass `actor.sub` explicitly for robustness.
 */
export async function applyRlsContext(
  tx: Prisma.TransactionClient,
  operatorId: string | null = currentOperatorId(),
): Promise<void> {
  if (!isRlsEnforced()) return;
  // Role name cannot be a bind parameter — it is a fixed, hardcoded literal (no injection surface).
  await tx.$executeRawUnsafe('SET LOCAL ROLE app_rw');
  // set_config with is_local=true is transaction-scoped; the operator id IS parameterised ($1).
  await tx.$queryRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, operatorId ?? '');
}
