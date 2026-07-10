/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for ledger posting against a REAL ephemeral PostgreSQL 16
 * (managed via the Docker CLI). Proves the guarantees that mocks cannot: balanced double-entry,
 * insufficient-balance rejection, idempotent replay, key conflict, cross-currency rejection,
 * and no double-spend under concurrency (FOR UPDATE serialization).
 *
 * Run with: `npm run test:int` (requires a running Docker daemon). Excluded from the default
 * unit `test` run by the `.int-spec.ts` suffix.
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
// NOTE: AppModule is imported dynamically inside beforeAll — ConfigModule.forRoot validates
// the environment eagerly at import time, so the env must be set first.

const CONTAINER = 'ftd-ledger-test-pg';
// Port 55444, NOT 55432: the Compose dev database publishes 55432, so reusing it made this suite
// fail with "port is already allocated" whenever `npm run dev` had been started.
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55444/fintech_test';
const POST = '/api/v1/transactions';

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
let clearingTRY: string; // shared per-currency system wallets
let revenueTRY: string;
let systemCustomerId: string | undefined;
let authHeader = ''; // operator Bearer token with transactions.create

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  // This suite posts many transactions in one window; the 30/min write throttle (audit M10) is a
  // production concern, not what these tests verify. Disable rate-limiting here (mirrors the other
  // write int-specs).
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55444:5432 postgres:16-alpine`,
  );
  await waitForPostgres();

  // Schema from the Prisma model, then the CHECK constraints + sequence Prisma can't express.
  sh('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL },
  });

  // Deferred import: AppModule triggers eager env validation in ConfigModule.forRoot.
  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.register(fastifyCookie); // refresh-token httpOnly cookie; mirrors main.ts
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_leg_check CHECK (leg IN ('DEBIT','CREDIT'))`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_check CHECK (amount_minor > 0)`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_state_check CHECK (state IN ('IN_PROGRESS','COMPLETED'))`,
  );
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS transaction_public_ref_seq`);

  // System-wallet purpose values + the customer/system coupling invariant, the
  // one-system-wallet-per-(currency,purpose) guarantee, and the reverse-once FK. (The migration
  // already created the reversal_of UNIQUE index from the @unique in the model.)
  await prisma.$executeRawUnsafe(
    `ALTER TABLE wallets ADD CONSTRAINT wallets_system_purpose_check CHECK (system_purpose IS NULL OR system_purpose IN ('CLEARING','REVENUE'))`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE wallets ADD CONSTRAINT wallets_system_coupling_check CHECK ((is_system AND system_purpose IS NOT NULL) OR (NOT is_system AND system_purpose IS NULL))`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX wallets_system_lookup ON wallets (currency, system_purpose) WHERE is_system`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE transactions ADD CONSTRAINT transactions_reversal_of_fkey FOREIGN KEY (reversal_of) REFERENCES transactions(id)`,
  );

  // One CLEARING + one REVENUE system wallet for TRY. Other-currency tests (USD) intentionally
  // have none, to exercise the fail-closed `SystemWalletMissing` path.
  clearingTRY = await seedSystemWallet('CLEARING', 'TRY');
  revenueTRY = await seedSystemWallet('REVENUE', 'TRY');

  // /transactions is gated by transactions.create — seed an operator and log in.
  const password = 'Test-Passw0rd!';
  const userId = uuidv7();
  const roleId = uuidv7();
  const permId = uuidv7();
  await prisma.user.create({
    data: { id: userId, email: 'operator@example.com', passwordHash: await hash(password) },
  });
  await prisma.role.create({ data: { id: roleId, name: 'operator' } });
  await prisma.permission.create({ data: { id: permId, code: 'transactions.create' } });
  await prisma.userRole.create({ data: { userId, roleId } });
  await prisma.rolePermission.create({ data: { roleId, permissionId: permId } });
  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email: 'operator@example.com', password });
  authHeader = `Bearer ${loginRes.body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

/** Seeds a customer→account→wallet with the given starting balance; returns the wallet id. */
async function seedWallet(balanceMinor: bigint, currency = 'TRY'): Promise<string> {
  const customerId = uuidv7();
  const accountId = uuidv7();
  const walletId = uuidv7();
  await prisma.customer.create({
    data: { id: customerId, fullName: 'Test Customer', email: `${customerId}@example.com` },
  });
  await prisma.account.create({
    data: { id: accountId, customerId, type: 'WALLET', currency },
  });
  await prisma.wallet.create({ data: { id: walletId, accountId, currency } });
  await prisma.walletBalance.create({
    data: { walletId, balanceMinor, availableBalanceMinor: balanceMinor },
  });
  return walletId;
}

/** A single sentinel "SYSTEM" customer (no PII) holds every system account/wallet. */
async function ensureSystemCustomer(): Promise<string> {
  if (!systemCustomerId) {
    systemCustomerId = uuidv7();
    await prisma.customer.create({
      data: { id: systemCustomerId, fullName: 'SYSTEM', email: `system-${systemCustomerId}@example.com` },
    });
  }
  return systemCustomerId;
}

/** Seeds a system (clearing/revenue) wallet on the sentinel holder; returns the wallet id. */
async function seedSystemWallet(
  purpose: 'CLEARING' | 'REVENUE',
  currency = 'TRY',
  balanceMinor = 0n,
): Promise<string> {
  const customerId = await ensureSystemCustomer();
  const accountId = uuidv7();
  const walletId = uuidv7();
  await prisma.account.create({ data: { id: accountId, customerId, type: 'WALLET', currency } });
  await prisma.wallet.create({
    data: { id: walletId, accountId, currency, isSystem: true, systemPurpose: purpose },
  });
  await prisma.walletBalance.create({
    data: { walletId, balanceMinor, availableBalanceMinor: balanceMinor },
  });
  return walletId;
}

const transferBody = (sourceWalletId: string, targetWalletId: string, amountMinor: number) => ({
  kind: 'TRANSFER',
  sourceWalletId,
  targetWalletId,
  amountMinor,
  currency: 'TRY',
});

const depositBody = (targetWalletId: string, amountMinor: number, currency = 'TRY') => ({
  kind: 'DEPOSIT',
  targetWalletId,
  amountMinor,
  currency,
});

const withdrawalBody = (sourceWalletId: string, amountMinor: number, currency = 'TRY') => ({
  kind: 'WITHDRAWAL',
  sourceWalletId,
  amountMinor,
  currency,
});

const feeBody = (sourceWalletId: string, amountMinor: number, currency = 'TRY') => ({
  kind: 'FEE',
  sourceWalletId,
  amountMinor,
  currency,
});

const reversalBody = (originalTransactionId: string, amountMinor: number, currency = 'TRY') => ({
  kind: 'REVERSAL',
  originalTransactionId,
  amountMinor,
  currency,
});

/**
 * POST /transactions with the operator Bearer token (the route is gated by transactions.create).
 * `Connection: close` forces a fresh socket per request — supertest's keep-alive agent otherwise
 * desyncs responses under the concurrent burst below (Fastify in-process server, "Parse Error").
 */
const txReq = () =>
  request(app.getHttpServer())
    .post(POST)
    .set('Authorization', authHeader)
    .set('Connection', 'close');

describe('POST /transactions — ledger posting (integration)', () => {
  it('posts a balanced TRANSFER and updates both balances (201)', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 25_000));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('POSTED');
    expect(res.body.data.publicRef).toMatch(/^TX-\d{4}-\d{6}$/);
    expect(res.body.meta.correlationId).toBeDefined();

    const [sb, tb] = await Promise.all([
      prisma.walletBalance.findUnique({ where: { walletId: source } }),
      prisma.walletBalance.findUnique({ where: { walletId: target } }),
    ]);
    expect(sb?.balanceMinor).toBe(75_000n);
    expect(tb?.balanceMinor).toBe(25_000n);

    const entries = await prisma.ledgerEntry.findMany({
      where: { transactionId: res.body.data.id },
    });
    const debit = entries.filter((e) => e.leg === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0n);
    const credit = entries.filter((e) => e.leg === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0n);
    expect(debit).toBe(credit); // double-entry invariant
  });

  it('rejects insufficient balance (422) and moves no money', async () => {
    const source = await seedWallet(10_000n);
    const target = await seedWallet(0n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 50_000));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('Transactions.InsufficientBalance');
    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(10_000n);
    const count = await prisma.ledgerEntry.count({ where: { walletId: source } });
    expect(count).toBe(0);
  });

  it('replays the same response for a repeated Idempotency-Key + same body (no second posting)', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const key = uuidv7();
    const body = transferBody(source, target, 30_000);

    const first = await txReq().set('Idempotency-Key', key).send(body);
    const second = await txReq().set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(70_000n); // posted once, not twice
  });

  it('returns 409 for the same Idempotency-Key with a different body', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const key = uuidv7();

    await txReq()
      .set('Idempotency-Key', key)
      .send(transferBody(source, target, 10_000));
    const conflict = await txReq()
      .set('Idempotency-Key', key)
      .send(transferBody(source, target, 99_999));

    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('Idempotency.KeyConflict');
  });

  it('rejects a cross-currency transfer (422)', async () => {
    const source = await seedWallet(100_000n, 'TRY');
    const target = await seedWallet(0n, 'USD');

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 10_000)); // body currency TRY ≠ target USD

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('Transactions.CrossCurrency');
  });

  it('requires the Idempotency-Key header (400)', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const res = await txReq().send(transferBody(source, target, 1_000));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Idempotency.KeyRequired');
  });

  it('serializes concurrent debits — no double-spend, balance never negative', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);

    // 10 concurrent transfers of 20_000 from a 100_000 balance ⇒ at most 5 can succeed.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        txReq()
          .set('Idempotency-Key', uuidv7())
          .send(transferBody(source, target, 20_000)),
      ),
    );

    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 422).length;
    expect(ok).toBe(5);
    expect(rejected).toBe(5);

    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    const tb = await prisma.walletBalance.findUnique({ where: { walletId: target } });
    expect(sb?.balanceMinor).toBe(0n);
    expect(sb?.balanceMinor).toBeGreaterThanOrEqual(0n);
    expect(tb?.balanceMinor).toBe(100_000n);
  });
});

describe('POST /transactions — remaining kinds (integration)', () => {
  it('posts a DEPOSIT (system CLEARING → target), credits the customer, stays balanced (201)', async () => {
    const target = await seedWallet(0n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(depositBody(target, 25_000));

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('POSTED');

    const tb = await prisma.walletBalance.findUnique({ where: { walletId: target } });
    expect(tb?.balanceMinor).toBe(25_000n);

    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: res.body.data.id } });
    const debit = entries.filter((e) => e.leg === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0n);
    const credit = entries.filter((e) => e.leg === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0n);
    expect(debit).toBe(credit); // double-entry invariant, system leg included
    expect(entries.some((e) => e.walletId === clearingTRY && e.leg === 'DEBIT')).toBe(true);
  });

  it('posts a WITHDRAWAL (source → system CLEARING) and debits the customer (201)', async () => {
    const source = await seedWallet(100_000n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(withdrawalBody(source, 30_000));

    expect(res.status).toBe(201);
    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(70_000n);

    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: res.body.data.id } });
    expect(entries.some((e) => e.walletId === clearingTRY && e.leg === 'CREDIT')).toBe(true);
  });

  it('rejects a WITHDRAWAL exceeding balance (422) and moves no money', async () => {
    const source = await seedWallet(10_000n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(withdrawalBody(source, 50_000));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('Transactions.InsufficientBalance');
    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(10_000n);
    expect(await prisma.ledgerEntry.count({ where: { walletId: source } })).toBe(0);
  });

  it('posts a FEE (source → system REVENUE) and credits revenue (201)', async () => {
    const source = await seedWallet(100_000n);

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(feeBody(source, 5_000));

    expect(res.status).toBe(201);
    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(95_000n);

    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: res.body.data.id } });
    expect(entries.some((e) => e.walletId === revenueTRY && e.leg === 'CREDIT')).toBe(true);
  });

  it('fails closed when no system wallet exists for the currency (422)', async () => {
    const target = await seedWallet(0n, 'USD'); // no USD CLEARING wallet was seeded

    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(depositBody(target, 10_000, 'USD'));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('Transactions.SystemWalletMissing');
    expect(await prisma.ledgerEntry.count({ where: { walletId: target } })).toBe(0);
  });

  it('REVERSAL of a POSTED transfer mirrors it, restores balances, marks it REVERSED (201)', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const transfer = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 40_000));
    expect(transfer.status).toBe(201);

    const reversal = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(reversalBody(transfer.body.data.id, 40_000));

    expect(reversal.status).toBe(201);

    const [sb, tb] = await Promise.all([
      prisma.walletBalance.findUnique({ where: { walletId: source } }),
      prisma.walletBalance.findUnique({ where: { walletId: target } }),
    ]);
    expect(sb?.balanceMinor).toBe(100_000n); // restored
    expect(tb?.balanceMinor).toBe(0n); // restored

    const original = await prisma.transaction.findUnique({ where: { id: transfer.body.data.id } });
    expect(original?.status).toBe('REVERSED');
    const reversalTx = await prisma.transaction.findUnique({ where: { id: reversal.body.data.id } });
    expect(reversalTx?.reversalOf).toBe(transfer.body.data.id);
  });

  it('rejects a second REVERSAL of the same transaction (409 AlreadyReversed)', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const transfer = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 20_000));

    const first = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(reversalBody(transfer.body.data.id, 20_000));
    const second = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(reversalBody(transfer.body.data.id, 20_000));

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('Transactions.AlreadyReversed');
  });

  it('replays an idempotent REVERSAL (same key) without reversing twice', async () => {
    const source = await seedWallet(100_000n);
    const target = await seedWallet(0n);
    const transfer = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send(transferBody(source, target, 35_000));

    const key = uuidv7();
    const body = reversalBody(transfer.body.data.id, 35_000);
    const first = await txReq().set('Idempotency-Key', key).send(body);
    const second = await txReq().set('Idempotency-Key', key).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id); // same posting replayed

    const sb = await prisma.walletBalance.findUnique({ where: { walletId: source } });
    expect(sb?.balanceMinor).toBe(100_000n); // reversed exactly once
  });

  it('rejects an unimplemented kind (ADJUSTMENT → 422 KindNotImplemented), posting nothing (audit A)', async () => {
    const res = await txReq()
      .set('Idempotency-Key', uuidv7())
      .send({ kind: 'ADJUSTMENT', amountMinor: 1_000, currency: 'TRY' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('Transactions.KindNotImplemented');
  });
});
