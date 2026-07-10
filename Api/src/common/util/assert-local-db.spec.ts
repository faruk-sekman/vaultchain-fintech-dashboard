/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the shared dev-only DATABASE_URL guard (F2). Pure + env-driven — no DB, no Prisma; the
 * destructive TRUNCATE is never executed. The "must block" corpus is the exact set of hostile URLs that
 * defeated the old `/localhost|127\.0\.0\.1|::1/` substring guard.
 */
import { assertLocalDb } from './assert-local-db';

describe('assertLocalDb (dev-only DATABASE_URL guard, F2)', () => {
  const ORIGINAL = {
    url: process.env.DATABASE_URL,
    node: process.env.NODE_ENV,
    optIn: process.env.FTD_SEED_DESTRUCTIVE,
  };
  const set = (url?: string, node?: string, optIn?: string): void => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    if (node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = node;
    if (optIn === undefined) delete process.env.FTD_SEED_DESTRUCTIVE;
    else process.env.FTD_SEED_DESTRUCTIVE = optIn;
  };
  afterEach(() => set(ORIGINAL.url, ORIGINAL.node, ORIGINAL.optIn));

  const call = (requireDestructiveOptIn = false): string =>
    assertLocalDb({ script: 'test', requireDestructiveOptIn });

  // ---- must BLOCK: the proven bypass corpus for the old substring guard ----
  it.each([
    ['RDS host with a localhost prefix', 'postgresql://u:p@localhost-primary.rds.amazonaws.com:5432/fintech'],
    ['subdomain trick', 'postgresql://localhost.evil.com:5432/app'],
    ['db-name is localhost', 'postgresql://u:p@db.acme.com:5432/localhost'],
    ['query param options=host=localhost', 'postgresql://u:p@db.acme.com:5432/app?options=host%3Dlocalhost'],
    ['app_name param = 127.0.0.1', 'postgresql://u:p@10.0.0.5:5432/app?application_name=127.0.0.1-canary'],
    ['password = localhost', 'postgresql://postgres:localhost@prod.rds.amazonaws.com:5432/fintech'],
  ])('BLOCKS a hostile URL (%s)', (_label: string, url: string) => {
    set(url, 'development');
    expect(() => call()).toThrow(/not an allowed local dev host/);
  });

  it('BLOCKS a missing DATABASE_URL (fail-closed)', () => {
    set(undefined, 'development');
    expect(() => call()).toThrow(/missing or unparseable/);
  });

  it('BLOCKS an unparseable DATABASE_URL', () => {
    set('::::not a url::::', 'development');
    expect(() => call()).toThrow(/missing or unparseable/);
  });

  it.each(['production', 'staging'])('BLOCKS a local URL under NODE_ENV=%s', (env: string) => {
    set('postgresql://postgres:postgres@localhost:55432/fintech_dev', env);
    expect(() => call()).toThrow(new RegExp(`NODE_ENV is "${env}"`));
  });

  it('BLOCKS a destructive script without the FTD_SEED_DESTRUCTIVE opt-in', () => {
    set('postgresql://postgres:postgres@localhost:55432/fintech_dev', 'development');
    expect(() => call(true)).toThrow(/FTD_SEED_DESTRUCTIVE=1/);
  });

  // ---- must ALLOW: real local dev URLs (returns the URL unchanged) ----
  it.each([
    ['compose override host/port', 'postgresql://postgres:postgres@localhost:55432/fintech_dev?schema=public'],
    ['legacy ftd-local-pg', 'postgresql://postgres:postgres@127.0.0.1:55440/fintech_dev'],
    ['bare localhost', 'postgresql://postgres:postgres@localhost:5432/fintech_dev'],
    ['in-container compose host db', 'postgresql://postgres:postgres@db:5432/fintech_dev'],
    ['ipv6 loopback', 'postgresql://postgres:postgres@[::1]:5432/fintech_dev'],
  ])('ALLOWS a local dev URL (%s)', (_label: string, url: string) => {
    set(url, 'development');
    expect(call()).toBe(url);
  });

  it('ALLOWS a destructive script when FTD_SEED_DESTRUCTIVE=1', () => {
    const url = 'postgresql://postgres:postgres@localhost:55432/fintech_dev';
    set(url, 'development', '1');
    expect(call(true)).toBe(url);
  });

  it('closes the substring bypass: the OLD regex passed an RDS URL the guard now blocks', () => {
    const rds = 'postgresql://u:p@localhost-primary.rds.amazonaws.com:5432/fintech';
    expect(/localhost|127\.0\.0\.1|::1/.test(rds)).toBe(true); // old guard: PASSED (the bug)
    set(rds, 'development');
    expect(() => call()).toThrow(/not an allowed local dev host/); // new guard: BLOCKED
  });
});
