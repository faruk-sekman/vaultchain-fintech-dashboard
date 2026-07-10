/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the customer wallet read endpoint against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves: the default wallet (balance + limits) is returned for a
 * customer; a customer without a wallet → 404; unknown customer → 404; 401 unauthenticated;
 * 403 without `wallets.read`.
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

const CONTAINER = 'ftd-wallets-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55438/fintech_test';

const READER = { email: 'wallet-reader@example.com', password: 'Test-Passw0rd!' };
const NOPERM = { email: 'wallet-noperm@example.com', password: 'Test-Passw0rd!' };

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
let withWalletId = '';
let noWalletId = '';

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
      `-e POSTGRES_DB=fintech_test -p 55438:5432 postgres:16-alpine`,
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
  await seedUser(READER.email, READER.password, ['wallets.read']);
  await seedUser(NOPERM.email, NOPERM.password, ['customers.read']); // authed, but no wallets.read

  // Customer WITH a default wallet + balance
  withWalletId = uuidv7();
  const accountId = uuidv7();
  const walletId = uuidv7();
  await prisma.customer.create({ data: { id: withWalletId, fullName: 'Wallet Holder', email: `${withWalletId}@example.com` } });
  await prisma.account.create({ data: { id: accountId, customerId: withWalletId, type: 'CHECKING', currency: 'TRY' } });
  await prisma.wallet.create({
    data: { id: walletId, accountId, currency: 'TRY', dailyLimitMinor: 500000n, monthlyLimitMinor: 5000000n, status: 'ACTIVE' },
  });
  await prisma.walletBalance.create({ data: { walletId, balanceMinor: 1234500n, availableBalanceMinor: 1200000n } });

  // Customer WITHOUT any wallet
  noWalletId = uuidv7();
  await prisma.customer.create({ data: { id: noWalletId, fullName: 'No Wallet', email: `${noWalletId}@example.com` } });

  readerAuth = `Bearer ${(await login(READER)).body.data.accessToken}`;
  nopermAuth = `Bearer ${(await login(NOPERM)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

const walletUrl = (id: string) => `/api/v1/customers/${id}/wallet`;

describe('GET /customers/:id/wallet (integration)', () => {
  it('returns the default wallet with balance + limits in the {data,meta} envelope', async () => {
    const res = await request(app.getHttpServer()).get(walletUrl(withWalletId)).set('Authorization', readerAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      currency: 'TRY',
      balanceMinor: '1234500',
      availableBalanceMinor: '1200000',
      dailyLimitMinor: '500000',
      monthlyLimitMinor: '5000000',
      status: 'ACTIVE',
      rowVersion: 0,
    });
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('404 when the customer has no wallet', async () => {
    const res = await request(app.getHttpServer()).get(walletUrl(noWalletId)).set('Authorization', readerAuth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Wallets.NotFound');
  });

  it('404 for an unknown customer', async () => {
    const res = await request(app.getHttpServer()).get(walletUrl(uuidv7())).set('Authorization', readerAuth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Customers.NotFound');
  });

  it('400 for a non-uuid id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/customers/not-a-uuid/wallet').set('Authorization', readerAuth);
    expect(res.status).toBe(400);
  });

  it('401 without a token', async () => {
    const res = await request(app.getHttpServer()).get(walletUrl(withWalletId));
    expect(res.status).toBe(401);
  });

  it('403 without wallets.read', async () => {
    const res = await request(app.getHttpServer()).get(walletUrl(withWalletId)).set('Authorization', nopermAuth);
    expect(res.status).toBe(403);
  });
});
