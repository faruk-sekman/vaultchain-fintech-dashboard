/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for Web3/AML risk persistence against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves the contract matrix: a decision is persisted with signals +
 * an audit row + a surfaced `isSimulated`; invalid address → 400; the honesty guard rejects
 * `isSimulated=false`; history is newest-first; and `kyc.manage`/`kyc.read` are enforced.
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

const CONTAINER = 'ftd-risk-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55436/fintech_test';
const ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

const OPERATOR = { email: 'kyc-op@example.com', password: 'Test-Passw0rd!' };
const READER = { email: 'kyc-reader@example.com', password: 'Test-Passw0rd!' };

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
let opAuth = '';
let readerAuth = '';
let customerId = '';

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
const decisionsUrl = (id: string) => `/api/v1/customers/${id}/risk-decisions`;
const assessmentsUrl = (id: string) => `/api/v1/customers/${id}/risk-assessments`;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55436:5432 postgres:16-alpine`,
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
  await seedUser(OPERATOR.email, OPERATOR.password, ['kyc.manage', 'kyc.read']);
  await seedUser(READER.email, READER.password, ['kyc.read']); // can read, cannot record
  customerId = uuidv7();
  await prisma.customer.create({ data: { id: customerId, fullName: 'Risk Subject', email: `${customerId}@example.com` } });

  opAuth = `Bearer ${(await login(OPERATOR)).body.data.accessToken}`;
  readerAuth = `Bearer ${(await login(READER)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

const validBody = {
  address: ADDRESS,
  decision: 'ALLOW',
  isSimulated: true,
  signals: [{ key: 'sanctionsHit', hit: false, severity: 'high' }],
};

describe('POST /customers/:id/risk-decisions (integration)', () => {
  it('persists the assessment + signals + audit row, surfaces isSimulated (201)', async () => {
    const res = await request(app.getHttpServer()).post(decisionsUrl(customerId)).set('Authorization', opAuth).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.isSimulated).toBe(true);
    expect(res.body.data.providerName).toBe('rule-based-risk-engine');
    expect(res.body.data.address).toBe(ADDRESS);
    expect(res.body.data.signals).toHaveLength(1);

    const signalCount = await prisma.riskSignal.count({ where: { riskAssessmentId: res.body.data.id } });
    expect(signalCount).toBe(1);
    const audit = await prisma.auditLog.count({ where: { action: 'risk.record_decision', outcome: 'SUCCESS' } });
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it('rejects a malformed address (400) and persists nothing', async () => {
    const before = await prisma.riskAssessment.count();
    const res = await request(app.getHttpServer())
      .post(decisionsUrl(customerId))
      .set('Authorization', opAuth)
      .send({ ...validBody, address: '0xnope' });
    expect(res.status).toBe(400);
    expect(await prisma.riskAssessment.count()).toBe(before);
  });

  it('honesty guard: isSimulated=false while the simulated engine is bound → 400', async () => {
    const res = await request(app.getHttpServer())
      .post(decisionsUrl(customerId))
      .set('Authorization', opAuth)
      .send({ ...validBody, isSimulated: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Risk.MislabeledSimulation');
  });

  it('404 for an unknown customer', async () => {
    const res = await request(app.getHttpServer()).post(decisionsUrl(uuidv7())).set('Authorization', opAuth).send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Risk.CustomerNotFound');
  });

  it('403 without kyc.manage', async () => {
    const res = await request(app.getHttpServer()).post(decisionsUrl(customerId)).set('Authorization', readerAuth).send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });
});

describe('GET /customers/:id/risk-assessments (integration)', () => {
  it('returns history newest-first with isSimulated on each (kyc.read)', async () => {
    await request(app.getHttpServer()).post(decisionsUrl(customerId)).set('Authorization', opAuth).send({ ...validBody, decision: 'REVIEW' });
    const res = await request(app.getHttpServer()).get(assessmentsUrl(customerId)).set('Authorization', readerAuth);
    expect(res.status).toBe(200);
    // Paginated `{ data, page }` envelope (was `{ items }`).
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.every((a: { isSimulated: boolean }) => a.isSimulated === true)).toBe(true);
    const times = res.body.data.map((a: { createdAt: string }) => new Date(a.createdAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x)); // non-increasing (newest first)
    expect(res.body.page.totalItems).toBeGreaterThanOrEqual(2);
  });
});
