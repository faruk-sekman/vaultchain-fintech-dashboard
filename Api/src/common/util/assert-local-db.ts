/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared dev-only DATABASE_URL guard for the manual seed / grant scripts (F2 / CWE-20, CWE-693).
 *
 * It replaces four hand-rolled substring regexes — the weakest of which (seed-fake-data) matched
 * `localhost` ANYWHERE in the connection string (userinfo, password, db-name, or query), so a production
 * URL such as `…@localhost-primary.rds.amazonaws.com/…`, or one whose password is literally `localhost`,
 * PASSED the guard and would have run a destructive `TRUNCATE`. This parses the URL and matches the
 * HOSTNAME against an exact allowlist, refuses under `NODE_ENV` production/staging, and fails CLOSED on any
 * parse ambiguity. It never logs the URL — only the parsed hostname is echoed, on refusal.
 */

/** Exact dev DB hosts. Host identity is the security boundary — ports are intentionally NOT part of it. */
const DEV_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'db']);

export interface AssertLocalDbOptions {
  /** Script name, used only to make a refusal message actionable. */
  script: string;
  /**
   * When true, ALSO require an explicit `FTD_SEED_DESTRUCTIVE=1` opt-in — for scripts that
   * unconditionally TRUNCATE/reset domain data, so a stray-but-local URL can never auto-wipe without a
   * deliberate confirmation.
   */
  requireDestructiveOptIn?: boolean;
}

/**
 * Return the validated `DATABASE_URL`, or throw (fail-closed) when it is not a recognised LOCAL dev
 * database. Pure + env-driven, so it is unit-testable without a DB.
 */
export function assertLocalDb(options: AssertLocalDbOptions): string {
  const { script, requireDestructiveOptIn = false } = options;
  const raw = process.env.DATABASE_URL ?? '';

  const env = (process.env.NODE_ENV ?? '').toLowerCase();
  if (env === 'production' || env === 'staging') {
    throw new Error(`${script} refused to run: NODE_ENV is "${env}" — this script is dev-only.`);
  }

  let host: string;
  try {
    // WHATWG URL does not accept the postgres/postgresql scheme cleanly; normalise it to http first so
    // `.hostname` reliably yields the HOST only (never userinfo/password/port/path/query).
    host = new URL(raw.replace(/^postgres(ql)?:\/\//i, 'http://')).hostname.toLowerCase();
  } catch {
    throw new Error(`${script} refused to run: DATABASE_URL is missing or unparseable.`);
  }

  if (!DEV_DB_HOSTS.has(host)) {
    throw new Error(`${script} refused to run: DATABASE_URL host "${host}" is not an allowed local dev host.`);
  }

  if (requireDestructiveOptIn && process.env.FTD_SEED_DESTRUCTIVE !== '1') {
    throw new Error(`${script} refused to TRUNCATE: set FTD_SEED_DESTRUCTIVE=1 to confirm a destructive local reseed.`);
  }

  return raw;
}
