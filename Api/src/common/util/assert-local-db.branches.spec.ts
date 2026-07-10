/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage riders for the dev-only DATABASE_URL guard (F2). The main assert-local-db.spec.ts
 * proves the security corpus but always passes an explicit `requireDestructiveOptIn` and always sets
 * NODE_ENV, so it never exercises the guard's two default-value legs:
 *   - the `requireDestructiveOptIn = false` destructuring default (property omitted), and
 *   - the `process.env.NODE_ENV ?? ''` nullish fallback (NODE_ENV unset).
 * These two tests take exactly those default paths. Pure + env-driven — no DB, no Prisma; behaviour is
 * asserted and product code is unchanged. Sibling of request-fingerprint.branches.spec.ts (same pattern).
 */
import { assertLocalDb } from './assert-local-db';

describe('assertLocalDb — default-value branch riders (F2)', () => {
  const LOCAL = 'postgresql://postgres:postgres@localhost:55432/fintech_dev';
  const ORIGINAL = {
    url: process.env.DATABASE_URL,
    node: process.env.NODE_ENV,
    optIn: process.env.FTD_SEED_DESTRUCTIVE,
  };
  const restore = (key: 'DATABASE_URL' | 'NODE_ENV' | 'FTD_SEED_DESTRUCTIVE', value?: string): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore('DATABASE_URL', ORIGINAL.url);
    restore('NODE_ENV', ORIGINAL.node);
    restore('FTD_SEED_DESTRUCTIVE', ORIGINAL.optIn);
  });

  // Covers the `requireDestructiveOptIn = false` destructuring default: calling WITHOUT the property must
  // take the default (false) path, so a valid local URL is returned and the FTD_SEED_DESTRUCTIVE opt-in is
  // NOT demanded (the opt-in env var is deliberately left unset to prove the default is non-destructive).
  it('defaults requireDestructiveOptIn to false when the property is omitted', () => {
    process.env.DATABASE_URL = LOCAL;
    process.env.NODE_ENV = 'development';
    delete process.env.FTD_SEED_DESTRUCTIVE;
    expect(assertLocalDb({ script: 'seed' })).toBe(LOCAL);
  });

  // Covers the `process.env.NODE_ENV ?? ''` nullish fallback: with NODE_ENV UNSET the guard must coalesce
  // to '' (neither "production" nor "staging"), pass the environment check, and validate the local host
  // normally — an unset NODE_ENV is treated as non-production, not as a hard refusal.
  it('treats an unset NODE_ENV as non-production and allows a local URL', () => {
    process.env.DATABASE_URL = LOCAL;
    delete process.env.NODE_ENV;
    expect(assertLocalDb({ script: 'seed', requireDestructiveOptIn: false })).toBe(LOCAL);
  });
});
