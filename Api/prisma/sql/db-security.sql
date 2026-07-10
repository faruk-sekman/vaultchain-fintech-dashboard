-- =============================================================================
-- Database security depth — least-privilege roles + Row-Level Security
--
-- APPLY at provision/deploy time (idempotent, re-runnable): `npm run prisma:security` runs this file —
-- it creates the least-privilege roles + grants + the append-only REVOKE + the RLS policies. Pair it
-- with `npm run prisma:integrity` (CHECK constraints + sequence). Order + per-environment steps:
-- docs/runbooks/db-security-provisioning.md (re-audit DATA-002/005).
--
-- ⚠️  STILL PENDING — the RLS policies only ENFORCE once the app CONNECTS as the
--     non-superuser `app_rw` role and sets `app.user_id` per request (`SELECT set_config('app.user_id',
--     $operatorId, true)`); a superuser/owner connection BYPASSES RLS. Until that app-connection wiring
--     lands, roles+grants+RLS are provisioned + reviewed but not yet enforcing on the live request path.
-- =============================================================================

-- ---------- Least-privilege roles (§3) ----------
-- `migrator`  : owns DDL + backfill; NOT the app's runtime role.
-- `app_rw`    : runtime; SELECT/INSERT/UPDATE on mutable tables; NO DELETE/UPDATE on append-only.
-- `audit_writer` : INSERT-only sink for audit_logs.
-- `readonly_analytics` : SELECT on the analytics matviews / metric_daily only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw')            THEN CREATE ROLE app_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'audit_writer')      THEN CREATE ROLE audit_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_analytics') THEN CREATE ROLE readonly_analytics NOLOGIN; END IF;
END $$;

-- SEC-003 runtime LOGIN role: the app connects as `app_login` (a LOGIN member of `app_rw`) so RLS +
-- least-privilege actually enforce — a superuser / table-owner connection BYPASSES RLS. Created with NO
-- password here (a password-less LOGIN role cannot authenticate); set it out-of-band from the secret
-- manager at deploy (`ALTER ROLE app_login PASSWORD ...`) — never commit a credential. `app_login` owns
-- nothing and is not superuser, so RLS applies to it. Point the app's `DATABASE_URL` at this role and run
-- migrations via the owner (`MIGRATE_DATABASE_URL`). Design: docs/security/rls-app-connection-design.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_login') THEN CREATE ROLE app_login LOGIN; END IF;
END $$;
GRANT app_rw TO app_login;   -- inherits app_rw's grants + RLS policies (INHERIT is the default)

-- Baseline grants for the runtime role (DELETE granted only on genuinely mutable tables).
GRANT SELECT, INSERT, UPDATE ON customers, accounts, wallets, wallet_balances, users, roles,
  permissions, user_roles, role_permissions, risk_assessments, risk_signals, refresh_tokens
  TO app_rw;
GRANT SELECT, INSERT ON transactions, ledger_entries, kyc_verifications, login_attempts TO app_rw;
GRANT SELECT, INSERT ON audit_logs TO app_rw;          -- append-only: NO update/delete grant
GRANT INSERT, SELECT ON audit_logs TO audit_writer;    -- dedicated append-only sink
-- metric_daily is created by the analytics rollup DDL (not the Prisma migrations); grant only if it exists yet so
-- this file applies cleanly regardless of provisioning order (the runbook applies it after the rollup).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_class WHERE relname = 'metric_daily') THEN
    GRANT SELECT ON metric_daily TO readonly_analytics;
  END IF;
END $$;

-- Append-only hard stop: never grant UPDATE/DELETE on the ledger or the audit chain.
REVOKE UPDATE, DELETE ON ledger_entries, audit_logs FROM app_rw;

-- ---------- Row-Level Security (§2) ----------
-- Defense-in-depth BEHIND the app's own authorization. `app.user_id` is set per request via
-- `SELECT set_config('app.user_id', $operatorId, true)` inside the request transaction.
ALTER TABLE customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_assessments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs         ENABLE ROW LEVEL SECURITY;

-- customers: app_rw sees non-deleted rows.
DROP POLICY IF EXISTS customers_app_rw ON customers;
CREATE POLICY customers_app_rw ON customers
  FOR ALL TO app_rw
  USING (deleted_at IS NULL)
  WITH CHECK (true);

-- risk_assessments: readable/insertable by app_rw (scoped by app authz; tighten with GUC as needed).
DROP POLICY IF EXISTS risk_app_rw ON risk_assessments;
CREATE POLICY risk_app_rw ON risk_assessments
  FOR ALL TO app_rw
  USING (true)
  WITH CHECK (true);

-- audit_logs: append-only — INSERT only, no UPDATE/DELETE policy (and no grant above).
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT TO app_rw, audit_writer
  WITH CHECK (true);
DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT TO app_rw
  USING (true);

-- NOTE: `migrator` (table owner) bypasses RLS for DDL/backfill — documented + audited.
