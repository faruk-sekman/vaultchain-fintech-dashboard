/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the customer read endpoints against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves: masked paginated list in the {data,page,meta} envelope;
 * filter[kycStatus]; sort whitelist + ordering; page[size]>100 → 400; bad sort → 400; masked
 * detail with address/rowVersion; unknown id → 404; 401 unauthenticated; 403 without permission.
 * Also proves the unified active/passive taxonomy (TASK-FE-INT-013): `filter[active]=false` returns
 * exactly the non-ACTIVE rows and its count equals the dashboard summary `inactiveCount`.
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

const CONTAINER = 'ftd-customers-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55437/fintech_test';

const READER = { email: 'cust-reader@example.com', password: 'Test-Passw0rd!' };
const NOPERM = { email: 'cust-noperm@example.com', password: 'Test-Passw0rd!' };
const REVEALER = { email: 'cust-revealer@example.com', password: 'Test-Passw0rd!' };

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
let readerAuth = '';
let nopermAuth = '';
let revealerAuth = '';
let verifiedId = '';

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

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55437:5432 postgres:16-alpine`,
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
  await seedUser(READER.email, READER.password, ['customers.read']);
  await seedUser(NOPERM.email, NOPERM.password, []); // authenticated but no customers.read
  await seedUser(REVEALER.email, REVEALER.password, ['customers.read', 'customers.pii.reveal']);

  verifiedId = uuidv7();
  await prisma.customer.create({
    data: {
      id: verifiedId,
      fullName: 'Ada Lovelace',
      email: 'ada.lovelace@example.com',
      phone: '+90 555 123 4567',
      walletNumber: '1234567890123456',
      nationalIdLast4: '1234',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      contractSigned: true,
      dateOfBirth: new Date('1990-01-04'),
      addressCountry: 'TR',
      addressCity: 'Istanbul',
      addressPostal: '34000',
      addressLine1: '1 Analytical Engine St',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  });
  await prisma.customer.create({
    data: {
      id: uuidv7(),
      fullName: 'Grace Hopper',
      email: 'grace@example.com',
      kycStatus: 'PENDING',
      status: 'INACTIVE',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    },
  });
  // A CLOSED customer makes the taxonomy gap real: passive = INACTIVE+CLOSED (status <> 'ACTIVE'),
  // so the list "Pasif" count must include this row — matching the dashboard summary inactiveCount.
  await prisma.customer.create({
    data: {
      id: uuidv7(),
      fullName: 'Margaret Closed',
      email: 'margaret@example.com',
      kycStatus: 'EXPIRED',
      status: 'CLOSED',
      createdAt: new Date('2026-02-15T00:00:00Z'),
    },
  });
  await prisma.customer.create({
    data: {
      id: uuidv7(),
      fullName: 'Soft Deleted',
      email: 'deleted@example.com',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      deletedAt: new Date('2026-03-01T00:00:00Z'),
    },
  });

  readerAuth = `Bearer ${(await login(READER)).body.data.accessToken}`;
  nopermAuth = `Bearer ${(await login(NOPERM)).body.data.accessToken}`;
  revealerAuth = `Bearer ${(await login(REVEALER)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

const list = (qs = '') => request(app.getHttpServer()).get(`/api/v1/customers${qs}`).set('Authorization', readerAuth);

describe('GET /customers (integration)', () => {
  it('returns a masked, paginated list in the {data,page,meta} envelope (excludes soft-deleted)', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(3); // ACTIVE + INACTIVE + CLOSED; soft-deleted excluded
    expect(res.body.page).toEqual({ number: 1, size: 25, totalItems: 3, totalPages: 1 });
    expect(res.body.meta.correlationId).toBeDefined();

    const ada = res.body.data.find((c: { id: string }) => c.id === verifiedId);
    expect(ada.fullName).toBe('Ada L***');
    expect(ada.email).toBe('a***@e***.com');
    expect(ada.phone).toBe('*** *** 4567');
    expect(ada.walletNumber).toBe('************3456');
    expect(ada.nationalIdLast4).toBe('1234');
    expect(ada.email).not.toContain('lovelace');
  });

  it('filters by kycStatus (exact)', async () => {
    const res = await list('?filter[kycStatus]=PENDING');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].kycStatus).toBe('PENDING');
  });

  it('searches name/email via filter[q]', async () => {
    const res = await list('?filter[q]=grace');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].kycStatus).toBe('PENDING');
  });

  it('sorts by -createdAt (newest first)', async () => {
    const res = await list('?sort=-createdAt');
    expect(res.status).toBe(200);
    expect(res.body.data[0].kycStatus).toBe('EXPIRED'); // Margaret (Feb 15) is newest
  });

  it('honours page[size] and reports totals', async () => {
    const res = await list('?page[size]=1&page[number]=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toEqual({ number: 1, size: 1, totalItems: 3, totalPages: 3 });
  });

  it('rejects page[size] > 100 (400)', async () => {
    const res = await list('?page[size]=101');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Validation.Failed');
  });

  it('rejects a non-whitelisted sort field (400)', async () => {
    const res = await list('?sort=nationalIdLast4');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Validation.Failed');
  });

  it('401 without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/customers');
    expect(res.status).toBe(401);
  });

  it('403 without customers.read', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/customers').set('Authorization', nopermAuth);
    expect(res.status).toBe(403);
  });
});

describe('GET /customers — active/passive taxonomy (filter[active], TASK-FE-INT-013)', () => {
  const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((c) => c.id).sort();

  it('filter[active]=false returns exactly the non-ACTIVE rows (INACTIVE+CLOSED)', async () => {
    const [passive, all] = await Promise.all([list('?filter[active]=false&page[size]=100'), list('?page[size]=100')]);
    expect(passive.status).toBe(200);
    const expected = (all.body.data as { id: string; status: string }[])
      .filter((c) => c.status !== 'ACTIVE')
      .map((c) => c.id)
      .sort();
    expect(ids(passive)).toEqual(expected);
    // Every returned row is non-ACTIVE, and both INACTIVE and CLOSED are represented.
    const statuses = (passive.body.data as { status: string }[]).map((c) => c.status);
    expect(statuses.every((s) => s !== 'ACTIVE')).toBe(true);
    expect(statuses).toEqual(expect.arrayContaining(['INACTIVE', 'CLOSED']));
  });

  it('list passive count (filter[active]=false totalItems) == dashboard summary inactiveCount', async () => {
    const [passive, summary] = await Promise.all([
      list('?filter[active]=false&page[size]=100'),
      request(app.getHttpServer()).get('/api/v1/dashboard/summary').set('Authorization', readerAuth),
    ]);
    expect(passive.status).toBe(200);
    expect(summary.status).toBe(200);
    // The canonical passive definition is `status <> 'ACTIVE'` (INACTIVE+CLOSED) on BOTH surfaces.
    expect(passive.body.page.totalItems).toBe(summary.body.data.inactiveCount);
    expect(passive.body.data).toHaveLength(summary.body.data.inactiveCount);
  });

  it('filter[active]=true returns exactly the ACTIVE rows', async () => {
    const res = await list('?filter[active]=true&page[size]=100');
    expect(res.status).toBe(200);
    expect((res.body.data as { status: string }[]).every((c) => c.status === 'ACTIVE')).toBe(true);
    expect(res.body.data.some((c: { id: string }) => c.id === verifiedId)).toBe(true);
  });

  it('exact filter[status]=CLOSED still returns only CLOSED (power-use capability kept)', async () => {
    const res = await list('?filter[status]=CLOSED&page[size]=100');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('CLOSED');
  });

  it('exact filter[status] wins over filter[active] when both are sent', async () => {
    // active=true would normally mean ACTIVE, but the exact status=INACTIVE must take precedence.
    const res = await list('?filter[status]=INACTIVE&filter[active]=true&page[size]=100');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('INACTIVE');
  });

  it('an invalid filter[active] value is ignored (treated as undefined → all rows)', async () => {
    const res = await list('?filter[active]=maybe&page[size]=100');
    expect(res.status).toBe(200);
    expect(res.body.page.totalItems).toBe(3); // no filter applied
  });
});

describe('GET /customers/:id (integration)', () => {
  it('returns masked detail with address, contractSigned and rowVersion', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${verifiedId}`)
      .set('Authorization', readerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Ada L***');
    expect(res.body.data.dateOfBirth).toBe('1990-01-04');
    // Masked default: line1 reduced, city/postalCode dropped to null, country kept raw. The
    // READER lacks `customers.pii.reveal`, so even `?reveal=true` would stay masked (asserted below).
    expect(res.body.data.address).toEqual({ country: 'TR', city: null, postalCode: null, line1: '1***' });
    expect(res.body.data.address.line1).not.toContain('Analytical');
    expect(res.body.data.contractSigned).toBe(true);
    expect(typeof res.body.data.rowVersion).toBe('number');
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('404 for an unknown id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${uuidv7()}`)
      .set('Authorization', readerAuth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Customers.NotFound');
  });

  it('400 for a non-uuid id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/customers/not-a-uuid').set('Authorization', readerAuth);
    expect(res.status).toBe(400);
  });
});

// Role-based PII reveal: explicit, server-authoritative, audited.
describe('GET /customers — role-based PII reveal (?reveal=true)', () => {
  const RAW_ADDRESS = { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Analytical Engine St' };
  const MASKED_ADDRESS = { country: 'TR', city: null, postalCode: null, line1: '1***' };
  const auditCount = (where: object) => prisma.auditLog.count({ where });

  it('detail ?reveal=true with customers.pii.reveal returns RAW PII + writes exactly one customer.pii.reveal row', async () => {
    const before = await auditCount({ action: 'customer.pii.reveal', resourceId: verifiedId });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${verifiedId}?reveal=true`)
      .set('Authorization', revealerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Ada Lovelace');
    expect(res.body.data.email).toBe('ada.lovelace@example.com');
    expect(res.body.data.phone).toBe('+90 555 123 4567');
    expect(res.body.data.walletNumber).toBe('1234567890123456');
    expect(res.body.data.address).toEqual(RAW_ADDRESS);
    expect(res.body.data.nationalIdLast4).toBe('1234'); // last-4 even when revealed (never the full ID)
    const after = await auditCount({ action: 'customer.pii.reveal', resourceId: verifiedId });
    expect(after - before).toBe(1);
  });

  it('detail ?reveal=true WITHOUT the permission stays MASKED and writes no reveal row (fail-closed)', async () => {
    const before = await auditCount({ action: 'customer.pii.reveal' });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${verifiedId}?reveal=true`)
      .set('Authorization', readerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Ada L***');
    expect(res.body.data.address).toEqual(MASKED_ADDRESS);
    expect(await auditCount({ action: 'customer.pii.reveal' })).toBe(before);
  });

  it('list ?reveal=true returns RAW items + writes exactly ONE customer.pii.reveal_list summary row', async () => {
    const before = await auditCount({ action: 'customer.pii.reveal_list' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/customers?reveal=true&page[size]=100')
      .set('Authorization', revealerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(1);
    const ada = res.body.data.find((c: { id: string }) => c.id === verifiedId);
    expect(ada.fullName).toBe('Ada Lovelace'); // raw
    const after = await auditCount({ action: 'customer.pii.reveal_list' });
    expect(after - before).toBe(1); // ONE summary row regardless of item count (no per-row spray)
  });

  it('detail ?reveal=true for an unknown id is 404 and writes no reveal row', async () => {
    const before = await auditCount({ action: 'customer.pii.reveal' });
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${uuidv7()}?reveal=true`)
      .set('Authorization', revealerAuth);
    expect(res.status).toBe(404);
    expect(await auditCount({ action: 'customer.pii.reveal' })).toBe(before);
  });

  it('absent reveal is masked even for a reveal-capable principal (default-deny)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/customers/${verifiedId}`)
      .set('Authorization', revealerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Ada L***');
    expect(res.body.data.address).toEqual(MASKED_ADDRESS);
  });
});
