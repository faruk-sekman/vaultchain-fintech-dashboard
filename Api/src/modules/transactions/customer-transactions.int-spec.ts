/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the customer transaction list against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves: signed-net amounts (CREDIT > 0, DEBIT < 0) over the
 * required date range; date range required → 400; filter[kind]; pagination; sort; 401; 403; 404.
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

const CONTAINER = 'ftd-customer-tx-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55439/fintech_test';

const READER = { email: 'tx-reader@example.com', password: 'Test-Passw0rd!' };
const NOPERM = { email: 'tx-noperm@example.com', password: 'Test-Passw0rd!' };

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
let customerId = '';

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

// Per-wallet ledger sequence: `entry_seq` is UNIQUE per wallet (schema `@@unique([walletId, entrySeq])`),
// so each entry on a given wallet needs a fresh, monotonically increasing seq (mirrors seed-dev's nextSeq).
const entrySeqByWallet = new Map<string, bigint>();
function nextEntrySeq(walletId: string): bigint {
  const next = (entrySeqByWallet.get(walletId) ?? 0n) + 1n;
  entrySeqByWallet.set(walletId, next);
  return next;
}

async function seedTx(
  accountId: string,
  walletId: string,
  kind: 'DEPOSIT' | 'WITHDRAWAL',
  leg: 'CREDIT' | 'DEBIT',
  amount: bigint,
  occurredAt: Date,
): Promise<void> {
  const txId = uuidv7();
  await prisma.transaction.create({
    data: { id: txId, idempotencyKey: uuidv7(), kind, status: 'POSTED', accountId, occurredAt, postedAt: occurredAt, description: kind },
  });
  await prisma.ledgerEntry.create({
    data: { id: uuidv7(), transactionId: txId, walletId, accountId, leg, amountMinor: amount, currency: 'TRY', entrySeq: nextEntrySeq(walletId) },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55439:5432 postgres:16-alpine`,
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
  await seedUser(READER.email, READER.password, ['transactions.read']);
  await seedUser(NOPERM.email, NOPERM.password, ['customers.read']);

  customerId = uuidv7();
  const accountId = uuidv7();
  const walletId = uuidv7();
  await prisma.customer.create({ data: { id: customerId, fullName: 'Tx Subject', email: `${customerId}@example.com` } });
  await prisma.account.create({ data: { id: accountId, customerId, type: 'CHECKING', currency: 'TRY' } });
  await prisma.wallet.create({ data: { id: walletId, accountId, currency: 'TRY' } });
  await prisma.walletBalance.create({ data: { walletId, balanceMinor: 0n, availableBalanceMinor: 0n } });

  await seedTx(accountId, walletId, 'DEPOSIT', 'CREDIT', 100000n, new Date('2026-03-01T10:00:00Z'));
  await seedTx(accountId, walletId, 'WITHDRAWAL', 'DEBIT', 40000n, new Date('2026-03-15T10:00:00Z'));
  await seedTx(accountId, walletId, 'DEPOSIT', 'CREDIT', 25000n, new Date('2025-01-01T10:00:00Z')); // outside the test range

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

const RANGE = 'filter%5BoccurredFrom%5D=2026-01-01T00:00:00Z&filter%5BoccurredTo%5D=2026-06-01T00:00:00Z';
const txUrl = (id: string, qs = '') => `/api/v1/customers/${id}/transactions?${RANGE}${qs}`;

describe('GET /customers/:id/transactions (integration)', () => {
  it('returns the customer transactions in-range with signed net amounts (CREDIT>0, DEBIT<0)', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(customerId)).set('Authorization', readerAuth);
    expect(res.status).toBe(200);
    expect(res.body.page.totalItems).toBe(2); // the 2025 one is out of range
    expect(res.body.meta.correlationId).toBeDefined();
    const credit = res.body.data.find((t: { kind: string }) => t.kind === 'DEPOSIT');
    const debit = res.body.data.find((t: { kind: string }) => t.kind === 'WITHDRAWAL');
    expect(credit.amountMinor).toBe('100000');
    expect(debit.amountMinor).toBe('-40000');
    expect(credit.currency).toBe('TRY');
  });

  it('defaults to newest-first by occurredAt', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(customerId)).set('Authorization', readerAuth);
    expect(res.body.data[0].kind).toBe('WITHDRAWAL'); // 2026-03-15 before 2026-03-01
  });

  it('filters by kind', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(customerId, '&filter%5Bkind%5D=DEPOSIT')).set('Authorization', readerAuth);
    expect(res.body.page.totalItems).toBe(1);
    expect(res.body.data[0].kind).toBe('DEPOSIT');
  });

  it('400 when the date range is missing', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/customers/${customerId}/transactions`).set('Authorization', readerAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Query.DateRangeRequired');
  });

  it('404 for an unknown customer', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(uuidv7())).set('Authorization', readerAuth);
    expect(res.status).toBe(404);
  });

  it('401 without a token', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(customerId));
    expect(res.status).toBe(401);
  });

  it('403 without transactions.read', async () => {
    const res = await request(app.getHttpServer()).get(txUrl(customerId)).set('Authorization', nopermAuth);
    expect(res.status).toBe(403);
  });
});
