/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * SEC-003 RLS / least-privilege ENFORCEMENT integration test against a REAL ephemeral PostgreSQL 16.
 * The existing int-specs all connect as the `postgres` superuser (which BYPASSES Row-Level Security), so
 * the SEC-002 roles/grants/RLS in `prisma/sql/db-security.sql` have never actually been proven to enforce.
 * This spec provisions the full security artifact, then connects as the least-privilege `app_login` role
 * (a LOGIN member of `app_rw`) and asserts the boundary end-to-end on real PG:
 *   E1  app_rw cannot DELETE the append-only ledger (grant + REVOKE);
 *   E2  app_rw cannot UPDATE/DELETE the audit chain;
 *   E3  RLS actually filters — app_rw sees only non-deleted customers where the superuser sees all;
 *   E4  the grant matrix is COMPLETE for the core write paths (customers SELECT/INSERT/UPDATE, audit INSERT);
 *   E5  the per-request GUC is transaction-local — `SET LOCAL app.user_id` does NOT leak past COMMIT
 *       (a session GUC on a pooled connection would leak across requests — the design's crux);
 *   E6  `SET LOCAL ROLE app_rw` + `set_config('app.user_id', …, true)` work under `app_login` (the
 *       recommended per-request preamble).
 * Design: docs/security/rls-app-connection-design.md. Run with `npm run test:int` (Docker).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { uuidv7 } from '../../common/util/uuid';
import { applyRlsContext } from './rls-context';

const CONTAINER = 'ftd-rls-enforce-test-pg';
const PORT = 55446;
const SU_URL = `postgresql://postgres:postgres@localhost:${PORT}/fintech_rls`;
const APP_PW = 'app_login_test_pw'; // test-only, mirrors the existing `postgres:postgres` int-spec creds
const APP_URL = `postgresql://app_login:${APP_PW}@localhost:${PORT}/fintech_rls`;
const SQL_DIR = join(__dirname, '../../../prisma/sql');

function sh(command: string, opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execSync(command, { stdio: 'pipe', env: opts.env ?? process.env, input: opts.input }).toString();
}

async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      sh(`docker exec ${CONTAINER} pg_isready -U postgres -d fintech_rls`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('Postgres did not become ready in time.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Apply a raw-SQL artifact through psql inside the container with ON_ERROR_STOP (fail loudly). */
function applySql(file: string): void {
  sh(`docker exec -i ${CONTAINER} psql -U postgres -d fintech_rls -v ON_ERROR_STOP=1`, {
    input: readFileSync(join(SQL_DIR, file), 'utf8'),
  });
}

const seedCustomer = (prisma: PrismaClient, overrides: Record<string, unknown>) =>
  prisma.customer.create({
    data: {
      id: uuidv7(),
      fullName: 'RLS Subject',
      email: `rls.${uuidv7()}@example.com`,
      phone: '+90 555 000 1122',
      walletNumber: uuidv7().replace(/\D/g, '').padEnd(16, '0').slice(0, 16),
      nationalIdLast4: '4321',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      contractSigned: true,
      addressCountry: 'TR',
      addressCity: 'Izmir',
      addressPostal: '35000',
      addressLine1: '1 Policy St',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    },
  });

let su: Client;
let appc: Client;
let appPrisma: PrismaClient; // a Prisma client connected AS app_login (exercises applyRlsContext via Prisma)
let liveCustomerId = '';

beforeAll(async () => {
  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_rls -p ${PORT}:5432 postgres:16-alpine`,
  );
  await waitForPostgres();

  // 1. schema, 2. integrity constraints, 3. roles + grants + RLS (+ the new app_login role).
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: SU_URL } });
  applySql('integrity.sql');
  applySql('db-security.sql');
  // Give the (password-less) app_login role a test password so we can connect over TCP.
  sh(`docker exec ${CONTAINER} psql -U postgres -d fintech_rls -c "ALTER ROLE app_login PASSWORD '${APP_PW}'"`);

  // Seed as the owner (bypasses RLS): one live + one soft-deleted customer.
  const seeder = new PrismaClient({ adapter: new PrismaPg({ connectionString: SU_URL }) });
  const live = await seedCustomer(seeder, {});
  liveCustomerId = live.id;
  await seedCustomer(seeder, { deletedAt: new Date('2026-02-01T00:00:00Z') });
  await seeder.$disconnect();

  su = new Client({ connectionString: SU_URL });
  await su.connect();
  appc = new Client({ connectionString: APP_URL });
  await appc.connect();
  appPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL }) });
}, 180_000);

afterAll(async () => {
  try {
    await appPrisma?.$disconnect();
    await su?.end();
    await appc?.end();
  } finally {
    try {
      sh(`docker rm -f ${CONTAINER}`);
    } catch {
      // best-effort teardown
    }
  }
});

const privilege = async (table: string, priv: string): Promise<boolean> => {
  const { rows } = await appc.query<{ can: boolean }>(
    `SELECT has_table_privilege('app_login', $1, $2) AS can`,
    [table, priv],
  );
  return rows[0].can;
};

describe('SEC-003 E1/E2 — append-only tables reject mutation for app_rw', () => {
  it('E1: app_login has NO DELETE on ledger_entries and a real DELETE is refused', async () => {
    expect(await privilege('ledger_entries', 'DELETE')).toBe(false);
    await expect(appc.query('DELETE FROM ledger_entries')).rejects.toThrow(/permission denied/i);
  });

  it('E2: app_login has NO UPDATE or DELETE on the audit chain', async () => {
    expect(await privilege('audit_logs', 'UPDATE')).toBe(false);
    expect(await privilege('audit_logs', 'DELETE')).toBe(false);
    expect(await privilege('ledger_entries', 'UPDATE')).toBe(false);
  });
});

describe('SEC-003 E4 — the grant matrix is complete for the core write paths', () => {
  it('app_login can SELECT/INSERT/UPDATE customers and INSERT (append) audit_logs', async () => {
    expect(await privilege('customers', 'SELECT')).toBe(true);
    expect(await privilege('customers', 'INSERT')).toBe(true);
    expect(await privilege('customers', 'UPDATE')).toBe(true);
    expect(await privilege('audit_logs', 'INSERT')).toBe(true);
    expect(await privilege('audit_logs', 'SELECT')).toBe(true);
  });
});

describe('SEC-003 E3 — RLS actually filters (not bypassed like the superuser path)', () => {
  it('the superuser sees BOTH customers (RLS bypassed for the owner)', async () => {
    const { rows } = await su.query<{ n: string }>('SELECT count(*)::text AS n FROM customers');
    expect(Number(rows[0].n)).toBe(2);
  });

  it('app_rw sees ONLY the non-deleted customer (RLS USING deleted_at IS NULL) — via SET ROLE', async () => {
    await appc.query('SET ROLE app_rw');
    try {
      const { rows } = await appc.query<{ n: string }>('SELECT count(*)::text AS n FROM customers');
      expect(Number(rows[0].n)).toBe(1);
      const visible = await appc.query<{ id: string }>('SELECT id FROM customers');
      expect(visible.rows.map((r) => r.id)).toEqual([liveCustomerId]);
    } finally {
      await appc.query('RESET ROLE');
    }
  });

  it('the policy also applies to app_login via role membership (no SET ROLE needed)', async () => {
    const { rows } = await appc.query<{ n: string }>('SELECT count(*)::text AS n FROM customers');
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe('SEC-003 E5/E6 — per-request GUC + role are transaction-local (pooling-safe)', () => {
  it('E5: SET LOCAL app.user_id is visible inside the tx and does NOT leak past COMMIT', async () => {
    await appc.query('BEGIN');
    await appc.query(`SELECT set_config('app.user_id', 'operator-alpha', true)`); // true = is_local
    const inside = await appc.query<{ v: string | null }>(`SELECT current_setting('app.user_id', true) AS v`);
    expect(inside.rows[0].v).toBe('operator-alpha');
    await appc.query('COMMIT');

    const after = await appc.query<{ v: string | null }>(`SELECT current_setting('app.user_id', true) AS v`);
    expect(after.rows[0].v === '' || after.rows[0].v === null).toBe(true); // reset — no cross-request leak
  });

  it('E6: SET LOCAL ROLE app_rw + set_config together form a valid per-request preamble', async () => {
    await appc.query('BEGIN');
    await appc.query('SET LOCAL ROLE app_rw');
    await appc.query(`SELECT set_config('app.user_id', 'operator-1', true)`);
    const state = await appc.query<{ who: string; guc: string | null }>(
      `SELECT current_user AS who, current_setting('app.user_id', true) AS guc`,
    );
    expect(state.rows[0].who).toBe('app_rw'); // dropped from app_login to exactly app_rw
    expect(state.rows[0].guc).toBe('operator-1');
    await appc.query('COMMIT');

    // After COMMIT the role reverts to the login role (transaction-local).
    const reverted = await appc.query<{ who: string }>('SELECT current_user AS who');
    expect(reverted.rows[0].who).toBe('app_login');
  });
});

describe('SEC-003 E7 — applyRlsContext helper enforces the preamble via Prisma (real PG)', () => {
  const ORIGINAL_FLAG = process.env.DB_RLS_ENFORCED;
  beforeAll(() => {
    process.env.DB_RLS_ENFORCED = '1'; // turn enforcement ON for this block only
  });
  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.DB_RLS_ENFORCED;
    else process.env.DB_RLS_ENFORCED = ORIGINAL_FLAG;
  });

  it('sets current_user=app_rw + app.user_id INSIDE the Prisma transaction (validates $executeRaw/$queryRaw)', async () => {
    const rows = await appPrisma.$transaction(async (tx) => {
      await applyRlsContext(tx, 'operator-42');
      return tx.$queryRawUnsafe<Array<{ who: string; guc: string | null }>>(
        `SELECT current_user AS who, current_setting('app.user_id', true) AS guc`,
      );
    });
    expect(rows[0].who).toBe('app_rw');
    expect(rows[0].guc).toBe('operator-42');
  });

  it('the role + GUC do NOT leak past the Prisma transaction (transaction-local)', async () => {
    const rows = await appPrisma.$queryRawUnsafe<Array<{ who: string; guc: string | null }>>(
      `SELECT current_user AS who, current_setting('app.user_id', true) AS guc`,
    );
    expect(rows[0].who).toBe('app_login'); // reverted from app_rw to the login role
    expect(rows[0].guc === '' || rows[0].guc === null).toBe(true);
  });
});
