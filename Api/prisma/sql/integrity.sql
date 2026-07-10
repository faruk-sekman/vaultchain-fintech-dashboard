-- Copyright (c) 2026 Fintech Dashboard contributors.
--
-- Runtime-applied ledger/wallet integrity backstop (re-audit DATA-002/005).
--
-- WHY: the Prisma migrations create the TABLES from schema.prisma but NOT the DB-level CHECK
-- constraints or the public-ref sequence — those previously lived only in scripts/seed-dev.ts (dev)
-- + the integration-test setup, so a non-seeded / production database provisioned from the schema
-- alone was missing its financial-integrity guardrails.
--
-- This file is the single, reusable, ROLE-INDEPENDENT artifact for those constraints. It is fully
-- IDEMPOTENT (safe to run on every deploy / after every `migrate deploy`): `DROP … IF EXISTS` before each
-- `ADD CONSTRAINT`, and `IF NOT EXISTS` for the sequence + index. Apply with `npm run prisma:integrity`.
--
-- NOT here (they need provisioned DB ROLES — app_rw / audit_writer / readonly_analytics — that a plain
-- database lacks, so they belong to a role-provisioned deploy step): the append-only REVOKE + Row-Level
-- Security policies. Those remain in prisma/sql/db-security.sql and are wired at deploy time (SEC-003).

-- Monotonic public reference for transactions (human-facing id). Create only — never RESTART here
-- (a RESTART would rewind production counters; the dev-only reset stays in seed-dev.ts).
CREATE SEQUENCE IF NOT EXISTS transaction_public_ref_seq;

-- Ledger double-entry leg + positive-amount invariants.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_leg_check;
ALTER TABLE ledger_entries ADD  CONSTRAINT ledger_entries_leg_check CHECK (leg IN ('DEBIT', 'CREDIT'));

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_amount_check;
ALTER TABLE ledger_entries ADD  CONSTRAINT ledger_entries_amount_check CHECK (amount_minor > 0);

-- System-wallet coupling: a system wallet must declare a purpose; a customer wallet must not.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_system_purpose_check;
ALTER TABLE wallets ADD  CONSTRAINT wallets_system_purpose_check
  CHECK (system_purpose IS NULL OR system_purpose IN ('CLEARING', 'REVENUE'));

ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_system_coupling_check;
ALTER TABLE wallets ADD  CONSTRAINT wallets_system_coupling_check
  CHECK ((is_system AND system_purpose IS NOT NULL) OR (NOT is_system AND system_purpose IS NULL));

-- One system wallet per (currency, purpose).
CREATE UNIQUE INDEX IF NOT EXISTS wallets_system_lookup ON wallets (currency, system_purpose) WHERE is_system;

-- A15/A16 (bugfix-backlog-2026-07): at most ONE open (PENDING) admin-approval password-reset request
-- per account. The AUTHORITATIVE guard is the service-level transactional re-check in
-- PasswordResetRequestService.create(); this partial unique index is the production backstop for it.
-- (Databases provisioned from the migrations alone — dev / integration containers — do not carry this
-- index, which is why the service check must stay authoritative.)
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_requests_single_open
  ON password_reset_requests (user_id) WHERE status = 'PENDING';

-- Finding [12] (CWE-362): customer email must be unique among NON-soft-deleted rows, case-insensitively
-- (the service compares with mode:'insensitive'). The service's in-transaction findFirst re-check stays as
-- the friendly fast-path; THIS partial unique index is the production backstop that closes the TOCTOU race
-- (two concurrent creates both passing the racy check). Predicate is deleted_at IS NULL (NOT status) to
-- match every read path + the service duplicate check. Databases provisioned from the migrations alone do
-- not carry this index, so the service check must stay authoritative.
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_active_unique
  ON customers (lower(email)) WHERE deleted_at IS NULL;

-- QA (CWE-362, KYC integrity): one ACTIVE customer per national ID. national_id is envelope-encrypted with
-- a random IV so the ciphertext can't be uniqued; the service stores a deterministic keyed blind index
-- (national_id_hash = HMAC of the plaintext) and THIS partial unique index enforces it among non-deleted
-- rows. Mirrors the email backstop: the in-transaction findFirst re-check is the friendly fast-path, this
-- index is the production backstop that closes the concurrent-create race.
CREATE UNIQUE INDEX IF NOT EXISTS customers_national_id_active_unique
  ON customers (national_id_hash) WHERE deleted_at IS NULL;
