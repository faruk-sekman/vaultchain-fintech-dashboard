/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the customer + wallet WRITE endpoints against a REAL
 * ephemeral PostgreSQL 16 (Docker CLI). Proves: create persists a customer + default wallet with
 * the national ID column-encrypted (never returned) and only last4 exposed; duplicate email → 409;
 * invalid TC No → 400; update is rowVersion-guarded (stale → 409) and a KYC change writes a
 * kyc_verifications row + audit entry; soft-delete hides the row (then 404); wallet limit PATCH is
 * rowVersion-guarded with major→minor conversion and a daily<monthly rule; plus 401/403 gating.
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port. Excluded from the unit run.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { hash } from '@node-rs/argon2';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const CONTAINER = 'ftd-customer-writes-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55441/fintech_test';

const MANAGER = { email: 'cw-manager@example.com', password: 'Test-Passw0rd!' };
const READER = { email: 'cw-reader@example.com', password: 'Test-Passw0rd!' };
// Holds customers.manage (create/update) but NOT customers.delete — proves the delete re-gate.
const EDITOR = { email: 'cw-editor@example.com', password: 'Test-Passw0rd!' };

// Checksum-valid TC Kimlik No values (verified by the official algorithm).
const TC_A = '10000000146';
const TC_B = '19191919190';

function sh(command: string, opts: { env?: NodeJS.ProcessEnv } = {}): string {
  return execSync(command, { stdio: 'pipe', env: opts.env ?? process.env }).toString();
}

async function waitForPostgres(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      sh(`docker exec ${CONTAINER} pg_isready -U postgres -d fintech_test`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('Postgres did not become ready in time.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

let app: NestFastifyApplication;
let prisma: PrismaService;
let managerAuth = '';
let readerAuth = '';
let editorAuth = '';

async function seedUser(email: string, password: string, codes: string[]): Promise<void> {
  const userId = uuidv7();
  const roleId = uuidv7();
  await prisma.user.create({ data: { id: userId, email: email.toLowerCase(), passwordHash: await hash(password) } });
  await prisma.role.create({ data: { id: roleId, name: `role-${userId}` } });
  await prisma.userRole.create({ data: { userId, roleId } });
  for (const code of codes) {
    const existing = await prisma.permission.findUnique({ where: { code } });
    const permission = existing ?? (await prisma.permission.create({ data: { id: uuidv7(), code } }));
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  }
}

const login = (creds: { email: string; password: string }) =>
  request(app.getHttpServer()).post('/api/v1/auth/login').send(creds);

const post = (body: object, auth = managerAuth) =>
  request(app.getHttpServer()).post('/api/v1/customers').set('Authorization', auth).send(body);

const validCreate = (overrides: Record<string, unknown> = {}) => ({
  fullName: 'Test Customer',
  email: `new.customer.${uuidv7()}@example.com`,
  phone: '+90 555 111 2233',
  nationalId: TC_A,
  dateOfBirth: '1990-01-04',
  address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
  ...overrides,
});

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';
  // MFA_REQUIRED is forced OFF centrally in jest.setup.cjs (seed users are not MFA-enrolled) — see there.
  delete process.env.FTD_PII_MASTER_KEY; // exercise the dev-fallback PII key path
  process.env.NODE_ENV = 'test';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55441:5432 postgres:16-alpine`,
  );
  await waitForPostgres();
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.register(fastifyCookie); // refresh-token httpOnly cookie; mirrors main.ts
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  // F12: apply the customer-email partial-unique backstop. It lives in prisma/sql/integrity.sql (NOT
  // schema.prisma), so the migration above does not create it — without this the race test below would
  // false-green (both concurrent creates would win). Mirrors the production `npm run prisma:integrity` step.
  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS customers_email_active_unique ON customers (lower(email)) WHERE deleted_at IS NULL',
  );
  // MANAGER gains customers.delete so the DELETE-204 happy path still passes after the re-gate.
  await seedUser(MANAGER.email, MANAGER.password, ['customers.read', 'customers.manage', 'customers.update', 'customers.delete', 'wallets.read', 'wallets.manage-limits']);
  await seedUser(READER.email, READER.password, ['customers.read', 'wallets.read']); // no *.manage
  await seedUser(EDITOR.email, EDITOR.password, ['customers.read', 'customers.manage', 'wallets.read']); // manage, NOT delete

  managerAuth = `Bearer ${(await login(MANAGER)).body.data.accessToken}`;
  readerAuth = `Bearer ${(await login(READER)).body.data.accessToken}`;
  editorAuth = `Bearer ${(await login(EDITOR)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

// Every test builds its own rows but reuses the FIXED valid national IDs (TC_A/TC_B — real TCKN
// checksums are not generatable per test without duplicating the validator). Since the F0
// Customers.DuplicateNationalId guard landed, an active leftover from one test 409s the next
// test's create on the NATIONAL-ID axis before the email axis under test is ever reached.
// Reset the customer aggregate between tests; CASCADE clears the FK children (wallets,
// transactions, kyc rows). Seeded users/roles live in separate tables and are untouched.
afterEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE customers CASCADE');
});

describe('POST /customers (integration)', () => {
  it('creates a customer + default wallet; encrypts the national ID and returns only last4', async () => {
    const body = validCreate();
    const res = await post(body);
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    expect(id).toBeDefined();
    expect(res.body.data.nationalIdLast4).toBe(TC_A.slice(-4));
    expect(res.body.data.fullName).toBe('Test C***'); // masked
    expect(res.body.data).not.toHaveProperty('nationalIdEnc');
    expect(res.body.data.rowVersion).toBe(0);

    // The national ID is column-encrypted at rest (blob present, not the plaintext) — never returned.
    const row = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(row.nationalIdEnc).toBeTruthy();
    expect(Buffer.from(row.nationalIdEnc!).toString('utf8')).not.toContain(TC_A);

    // The default wallet exists (GET /customers/:id/wallet returns 200).
    const wallet = await request(app.getHttpServer()).get(`/api/v1/customers/${id}/wallet`).set('Authorization', managerAuth);
    expect(wallet.status).toBe(200);
    expect(wallet.body.data.status).toBe('ACTIVE');
    expect(wallet.body.data.dailyLimitMinor).toBe('1000000');
  });

  it('rejects a duplicate (non-deleted) email with 409', async () => {
    const body = validCreate({ email: `dup.${uuidv7()}@example.com` });
    expect((await post(body)).status).toBe(201);
    const again = await post({ ...validCreate(), email: body.email, nationalId: TC_B });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('Customers.DuplicateEmail');
  });

  it('F12: closes the TOCTOU race — two CONCURRENT creates for the same email → exactly one 201 and one 409', async () => {
    const email = `race.${uuidv7()}@example.com`;
    const [a, b] = await Promise.all([
      post(validCreate({ email, nationalId: TC_A })),
      post(validCreate({ email, nationalId: TC_B })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    // Which 409 the loser gets is a genuine race between the two F12 layers: if the app-level
    // pre-check sees the winner's committed row it reports Customers.DuplicateEmail; if both
    // pass the pre-check simultaneously, the raw-SQL partial-unique backstop rejects the loser
    // and Prisma's P2002 (no schema-known target for the raw index) maps to the generic
    // Resource.Conflict. Both are correct outcomes of the guarantee under test — atomicity —
    // which the status pair above and the row count below pin strictly.
    expect(['Customers.DuplicateEmail', 'Resource.Conflict']).toContain(conflict.body.error.code);
    // The DB backstop kept it to EXACTLY one active customer for that email.
    const count = await prisma.customer.count({
      where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    });
    expect(count).toBe(1);
  });

  it('F12: the backstop is case-insensitive — concurrent same-email-different-case → one 201, one 409', async () => {
    const email = `Case.${uuidv7()}@Example.com`;
    const [a, b] = await Promise.all([
      post(validCreate({ email, nationalId: TC_A })),
      post(validCreate({ email: email.toLowerCase(), nationalId: TC_B })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('F12: soft-deleting a customer frees its email for reuse (partial index WHERE deleted_at IS NULL)', async () => {
    const email = `reuse.${uuidv7()}@example.com`;
    const first = await post(validCreate({ email, nationalId: TC_A }));
    expect(first.status).toBe(201);
    const del = await request(app.getHttpServer())
      .delete(`/api/v1/customers/${first.body.data.id}`)
      .set('Authorization', managerAuth);
    expect(del.status).toBe(204);
    // The email is now free — a new ACTIVE customer can reuse it.
    const second = await post(validCreate({ email, nationalId: TC_B }));
    expect(second.status).toBe(201);
    // …but a THIRD live create of the same email now collides with the active second one.
    const third = await post(validCreate({ email, nationalId: TC_A }));
    expect(third.status).toBe(409);
  });

  it('rejects an invalid Turkish national ID with 400', async () => {
    const res = await post(validCreate({ nationalId: '12345678901' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Validation.Failed');
  });

  it('401 without a token, 403 without customers.manage', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/customers').send(validCreate())).status).toBe(401);
    expect((await post(validCreate(), readerAuth)).status).toBe(403);
  });
});

describe('PUT /customers/:id (integration)', () => {
  it('A12: 403 for a caller holding customers.manage but NOT customers.update (edit re-gate)', async () => {
    const created = await post(validCreate());
    const id = created.body.data.id as string;
    const res = await request(app.getHttpServer())
      .put(`/api/v1/customers/${id}`)
      .set('Authorization', editorAuth)
      .send({ kycStatus: 'IN_REVIEW', rowVersion: 0 });
    expect(res.status).toBe(403);
  });

  it('updates with the correct rowVersion, bumps it, and records a KYC change', async () => {
    const created = await post(validCreate());
    const id = created.body.data.id as string;

    const res = await request(app.getHttpServer())
      .put(`/api/v1/customers/${id}`)
      .set('Authorization', managerAuth)
      .send({ fullName: 'Renamed Person', email: created.body.data && `renamed.${id}@example.com`, kycStatus: 'VERIFIED', status: 'ACTIVE', rowVersion: 0 });
    expect(res.status).toBe(200);
    expect(res.body.data.rowVersion).toBe(1);

    const kyc = await prisma.kycVerification.findFirst({ where: { customerId: id, status: 'VERIFIED' } });
    expect(kyc).toBeTruthy();
    const audit = await prisma.auditLog.findFirst({ where: { resourceId: id, action: 'customer.kyc_change' } });
    expect(audit).toBeTruthy();
  });

  it('preserves omitted (masked) fields on a partial update', async () => {
    const body = validCreate({ fullName: 'Keep Me', email: `keep.${uuidv7()}@example.com` });
    const created = await post(body);
    const id = created.body.data.id as string;

    // Send ONLY a KYC change + rowVersion (as the form does when name/email/phone are untouched).
    const res = await request(app.getHttpServer())
      .put(`/api/v1/customers/${id}`)
      .set('Authorization', managerAuth)
      .send({ kycStatus: 'IN_REVIEW', rowVersion: 0 });
    expect(res.status).toBe(200);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(row.fullName).toBe('Keep Me'); // name/email preserved, not overwritten with a mask
    expect(row.email).toBe(body.email);
    expect(row.kycStatus).toBe('IN_REVIEW');
  });

  it('returns 409 on a stale rowVersion', async () => {
    const created = await post(validCreate());
    const id = created.body.data.id as string;
    const update = { fullName: 'Stale Test', email: `stale.${id}@example.com`, rowVersion: 99 };
    const res = await request(app.getHttpServer()).put(`/api/v1/customers/${id}`).set('Authorization', managerAuth).send(update);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('Customers.Conflict');
  });

  it('404 for an unknown id', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/v1/customers/${uuidv7()}`)
      .set('Authorization', managerAuth)
      .send({ fullName: 'Nobody Here', email: 'nobody@example.com', rowVersion: 0 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Customers.NotFound');
  });
});

describe('DELETE /customers/:id (integration)', () => {
  it('soft-deletes (204) and then hides the customer (404)', async () => {
    const created = await post(validCreate());
    const id = created.body.data.id as string;

    const del = await request(app.getHttpServer()).delete(`/api/v1/customers/${id}`).set('Authorization', managerAuth);
    expect(del.status).toBe(204);

    const get = await request(app.getHttpServer()).get(`/api/v1/customers/${id}`).set('Authorization', managerAuth);
    expect(get.status).toBe(404);

    const row = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeTruthy();
  });

  it('403 for callers without customers.delete (re-gated off customers.manage)', async () => {
    const created = await post(validCreate());
    const id = created.body.data.id as string;
    // A pure reader (no write perms) is forbidden …
    expect((await request(app.getHttpServer()).delete(`/api/v1/customers/${id}`).set('Authorization', readerAuth)).status).toBe(403);
    // … AND an editor holding customers.manage but NOT customers.delete is forbidden (separation of duties).
    expect((await request(app.getHttpServer()).delete(`/api/v1/customers/${id}`).set('Authorization', editorAuth)).status).toBe(403);
    // The row survives the denied attempts (not soft-deleted).
    const row = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeNull();
  });
});

describe('PATCH /customers/:id/wallet (integration)', () => {
  async function createWithWallet(): Promise<{ id: string; rowVersion: number }> {
    const created = await post(validCreate());
    const id = created.body.data.id as string;
    const wallet = await request(app.getHttpServer()).get(`/api/v1/customers/${id}/wallet`).set('Authorization', managerAuth);
    return { id, rowVersion: wallet.body.data.rowVersion as number };
  }

  it('updates limits (major→minor) with the correct rowVersion', async () => {
    const { id, rowVersion } = await createWithWallet();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}/wallet`)
      .set('Authorization', managerAuth)
      .send({ dailyLimit: 5000, monthlyLimit: 50000, rowVersion });
    expect(res.status).toBe(200);
    expect(res.body.data.dailyLimitMinor).toBe('500000');
    expect(res.body.data.monthlyLimitMinor).toBe('5000000');
    expect(res.body.data.rowVersion).toBe(rowVersion + 1);
  });

  it('rejects dailyLimit >= monthlyLimit with 400', async () => {
    const { id, rowVersion } = await createWithWallet();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}/wallet`)
      .set('Authorization', managerAuth)
      .send({ dailyLimit: 60000, monthlyLimit: 50000, rowVersion });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Wallets.InvalidLimits');
  });

  it('returns 409 on a stale rowVersion', async () => {
    const { id } = await createWithWallet();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}/wallet`)
      .set('Authorization', managerAuth)
      .send({ dailyLimit: 5000, monthlyLimit: 50000, rowVersion: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('Wallets.Conflict');
  });

  it('403 without wallets.manage-limits', async () => {
    const { id, rowVersion } = await createWithWallet();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${id}/wallet`)
      .set('Authorization', readerAuth)
      .send({ dailyLimit: 5000, monthlyLimit: 50000, rowVersion });
    expect(res.status).toBe(403);
  });
});
