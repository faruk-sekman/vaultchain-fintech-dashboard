/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Role-matrix integration tests against a REAL ephemeral PostgreSQL 16
 * (Docker CLI). Proves the full authorization boundary across the three enterprise roles end-to-end via
 * the booted Nest app over HTTP — every cell asserted with a real, login-minted JWT:
 *   - reads (all three roles see masked list/detail; Auditor sees roles.read);
 *   - reveal (Administrator unmasks + audited; Operator/Auditor stay masked + NO audit row; no leak);
 *   - delete (Administrator 204→404; Operator/Auditor 403→row survives);
 *   - create (Operator 201 masked); update (Administrator-only via customers.update — A12: Operator 403, Auditor 403);
 *   - escalation (Operator → roles.manage / users.manage 403; Auditor → customers.manage 403).
 * Self-contained: own container + port + local `seedUser` (does NOT import the dev seed). Mirrors the
 * matrix in scripts/seed-dev.ts ROLES but inlines the codes so the test is independent of seed refactors.
 *
 * Run with: `npm run test:int` (requires Docker). Excluded from the unit run.
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

const CONTAINER = 'ftd-role-matrix-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55442/fintech_test';

// The three enterprise matrices (mirror scripts/seed-dev.ts ROLES — inlined to stay seed-independent).
const ADMIN_CODES = [
  'customers.read', 'customers.manage', 'customers.update', 'customers.delete', 'customers.pii.reveal',
  'wallets.read', 'wallets.manage-limits', 'transactions.read', 'transactions.create',
  'kyc.read', 'kyc.manage', 'roles.read', 'roles.manage', 'permissions.manage', 'users.manage',
];
const OPERATOR_CODES = [
  'customers.read', 'customers.manage', 'wallets.read', 'wallets.manage-limits',
  'transactions.read', 'transactions.create', 'kyc.read', 'kyc.manage', 'roles.read',
];
const AUDITOR_CODES = ['customers.read', 'wallets.read', 'transactions.read', 'kyc.read', 'roles.read'];

const ADMIN = { email: 'rm-admin@example.com', password: 'Test-Passw0rd!' };
const OPERATOR = { email: 'rm-operator@example.com', password: 'Test-Passw0rd!' };
const AUDITOR = { email: 'rm-auditor@example.com', password: 'Test-Passw0rd!' };
const TC_A = '10000000146'; // checksum-valid TC Kimlik No

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
let adminAuth = '';
let operatorAuth = '';
let auditorAuth = '';
let adminUserId = '';
let revealTargetId = '';

/** Creates a user + a role carrying exactly `codes` + the mapping; returns the user id (the JWT `sub`). */
async function seedUser(email: string, password: string, codes: string[]): Promise<string> {
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
  return userId;
}

const login = (creds: { email: string; password: string }) =>
  request(app.getHttpServer()).post('/api/v1/auth/login').send(creds);

const validCreate = (overrides: Record<string, unknown> = {}) => ({
  fullName: 'Matrix Customer',
  email: `matrix.${uuidv7()}@example.com`,
  phone: '+90 555 222 3344',
  nationalId: TC_A,
  dateOfBirth: '1991-02-03',
  address: { country: 'TR', city: 'Ankara', postalCode: '06000', line1: '5 Matrix Way' },
  ...overrides,
});

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';
  delete process.env.FTD_PII_MASTER_KEY; // exercise the dev-fallback PII key path (create encrypts national-id)
  process.env.NODE_ENV = 'test';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55442:5432 postgres:16-alpine`,
  );
  await waitForPostgres();
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.register(fastifyCookie);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  adminUserId = await seedUser(ADMIN.email, ADMIN.password, ADMIN_CODES);
  await seedUser(OPERATOR.email, OPERATOR.password, OPERATOR_CODES);
  await seedUser(AUDITOR.email, AUDITOR.password, AUDITOR_CODES);

  revealTargetId = uuidv7();
  await prisma.customer.create({
    data: {
      id: revealTargetId,
      fullName: 'Ada Lovelace',
      email: 'ada.matrix@example.com',
      phone: '+90 555 123 4567',
      walletNumber: '1234567890123456',
      nationalIdLast4: '1234',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      contractSigned: true,
      addressCountry: 'TR',
      addressCity: 'Istanbul',
      addressPostal: '34000',
      addressLine1: '1 Analytical Engine St',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  });

  adminAuth = `Bearer ${(await login(ADMIN)).body.data.accessToken}`;
  operatorAuth = `Bearer ${(await login(OPERATOR)).body.data.accessToken}`;
  auditorAuth = `Bearer ${(await login(AUDITOR)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

const GET = (path: string, auth: string) => request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', auth);
const auditCount = (where: object) => prisma.auditLog.count({ where });

describe('Role matrix — reads (all three roles)', () => {
  it.each([
    ['Administrator', () => adminAuth],
    ['Operator', () => operatorAuth],
    ['Auditor', () => auditorAuth],
  ])('%s can list + read masked customer detail (200)', async (_role, auth) => {
    expect((await GET('/customers', auth())).status).toBe(200);
    const detail = await GET(`/customers/${revealTargetId}`, auth());
    expect(detail.status).toBe(200);
    expect(detail.body.data.fullName).toBe('Ada L***'); // masked by default for everyone
  });

  it('Auditor can call the roles.read-gated GET /roles (200) — granted cell positively exercised', async () => {
    expect((await GET('/roles', auditorAuth)).status).toBe(200);
  });
});

describe('Role matrix — PII reveal (Administrator only, audited)', () => {
  it('Administrator ?reveal=true returns RAW PII + writes one customer.pii.reveal row by the admin sub', async () => {
    const before = await auditCount({ action: 'customer.pii.reveal', resourceId: revealTargetId });
    const res = await GET(`/customers/${revealTargetId}?reveal=true`, adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Ada Lovelace');
    expect(res.body.data.email).toBe('ada.matrix@example.com');
    expect(res.body.data.address).toEqual({ country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Analytical Engine St' });
    expect(res.body.data.nationalIdLast4).toBe('1234'); // last-4 even when revealed (no decrypt)
    expect(res.body.data).not.toHaveProperty('nationalId');
    expect(res.body.data).not.toHaveProperty('nationalIdEnc');
    const rows = await prisma.auditLog.findMany({ where: { action: 'customer.pii.reveal', resourceId: revealTargetId }, orderBy: { createdAt: 'desc' } });
    expect(rows.length).toBe(before + 1);
    expect(rows[0].actorUserId).toBe(adminUserId); // who-did-it accountability
  });

  it('Administrator list ?reveal=true writes exactly one customer.pii.reveal_list summary row (no per-row spray)', async () => {
    const beforeList = await auditCount({ action: 'customer.pii.reveal_list' });
    const beforeDetail = await auditCount({ action: 'customer.pii.reveal' });
    const res = await GET('/customers?reveal=true&page[size]=100', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.find((c: { id: string }) => c.id === revealTargetId).fullName).toBe('Ada Lovelace');
    expect((await auditCount({ action: 'customer.pii.reveal_list' })) - beforeList).toBe(1);
    expect(await auditCount({ action: 'customer.pii.reveal' })).toBe(beforeDetail); // no per-row detail rows
  });

  it.each([
    ['Operator', () => operatorAuth],
    ['Auditor', () => auditorAuth],
  ])('%s ?reveal=true stays MASKED, writes no audit row, and leaks nothing (deep-equal to masked baseline)', async (_role, auth) => {
    const before = await auditCount({ action: 'customer.pii.reveal' });
    const masked = await GET(`/customers/${revealTargetId}`, auth());
    const revealed = await GET(`/customers/${revealTargetId}?reveal=true`, auth());
    expect(revealed.status).toBe(200);
    expect(revealed.body.data.address).toEqual({ country: 'TR', city: null, postalCode: null, line1: '1***' });
    expect(revealed.body.data).toEqual(masked.body.data); // masking does not leak — identical to no-reveal
    expect(await auditCount({ action: 'customer.pii.reveal' })).toBe(before);
  });
});

describe('Role matrix — delete (customers.delete, Administrator only)', () => {
  it('Operator DELETE → 403 and the customer survives (re-GET 200)', async () => {
    const res = await request(app.getHttpServer()).delete(`/api/v1/customers/${revealTargetId}`).set('Authorization', operatorAuth);
    expect(res.status).toBe(403);
    expect((await GET(`/customers/${revealTargetId}`, operatorAuth)).status).toBe(200);
  });

  it('Auditor DELETE → 403 and the customer survives (re-GET 200)', async () => {
    const res = await request(app.getHttpServer()).delete(`/api/v1/customers/${revealTargetId}`).set('Authorization', auditorAuth);
    expect(res.status).toBe(403);
    expect((await GET(`/customers/${revealTargetId}`, auditorAuth)).status).toBe(200);
  });

  it('Administrator DELETE → 204 and the customer is then hidden (re-GET 404)', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/customers').set('Authorization', adminAuth).send(validCreate());
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const del = await request(app.getHttpServer()).delete(`/api/v1/customers/${id}`).set('Authorization', adminAuth);
    expect(del.status).toBe(204);
    expect((await GET(`/customers/${id}`, adminAuth)).status).toBe(404);
  });
});

describe('Role matrix — create/update + escalation surface', () => {
  it('Operator can create (201, masked) but can NO LONGER update — A12: edit is Administrator-only', async () => {
    const created = await request(app.getHttpServer()).post('/api/v1/customers').set('Authorization', operatorAuth).send(validCreate());
    expect(created.status).toBe(201);
    expect(created.body.data.fullName).toBe('Matrix C***'); // masked even for the creator
    const id = created.body.data.id as string;

    // A12/K5: PUT re-gated onto customers.update (Administrator-only) — the Operator's
    // customers.manage no longer opens the edit surface.
    const operatorUpdate = await request(app.getHttpServer())
      .put(`/api/v1/customers/${id}`)
      .set('Authorization', operatorAuth)
      .send({ kycStatus: 'IN_REVIEW', rowVersion: created.body.data.rowVersion });
    expect(operatorUpdate.status).toBe(403);

    // The Administrator (holder of customers.update) still updates fine.
    const adminUpdate = await request(app.getHttpServer())
      .put(`/api/v1/customers/${id}`)
      .set('Authorization', adminAuth)
      .send({ kycStatus: 'IN_REVIEW', rowVersion: created.body.data.rowVersion });
    expect(adminUpdate.status).toBe(200);
  });

  it('Auditor cannot create or update (403)', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/customers').set('Authorization', auditorAuth).send(validCreate())).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).put(`/api/v1/customers/${revealTargetId}`).set('Authorization', auditorAuth).send({ kycStatus: 'IN_REVIEW', rowVersion: 0 })).status,
    ).toBe(403);
  });

  it('Operator is denied the role/permission/user management surface (403)', async () => {
    // roles.manage
    expect((await request(app.getHttpServer()).post('/api/v1/roles').set('Authorization', operatorAuth).send({ name: 'should-not-create' })).status).toBe(403);
    // users.manage
    expect(
      (await request(app.getHttpServer()).post(`/api/v1/users/${uuidv7()}/roles`).set('Authorization', operatorAuth).send({ roleId: uuidv7() })).status,
    ).toBe(403);
  });

  it('Auditor is denied role management (403)', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/roles').set('Authorization', auditorAuth).send({ name: 'nope' })).status).toBe(403);
  });
});
