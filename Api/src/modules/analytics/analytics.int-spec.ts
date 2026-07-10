/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the server-side dashboard aggregates against a REAL
 * ephemeral PostgreSQL 16 (Docker CLI). Proves what mocks cannot: the KPIs are correct above 60
 * customers (the bug that was fixed), the KYC distribution is zero-filled and totals-consistent,
 * `asOf` is fresh, the zero-customer path is empty, the daily rollup is idempotent, only
 * masked/aggregate data leaves the service, and the read path is LIVE — a creation or
 * soft-delete moves the summary count immediately with no materialized-view refresh.
 *
 * Run with: `npm run test:int` (requires a running Docker daemon). Uses its own container + port
 * so it never collides with the ledger integration suite. Excluded from the default unit run.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { CustomerStatus, KycStatus } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ANALYTICS_DDL } from './analytics.ddl';
import { AnalyticsService } from './analytics.service';
// NOTE: AppModule is imported dynamically in beforeAll — ConfigModule.forRoot validates the env
// eagerly at import time, so the env must be set first.

const CONTAINER = 'ftd-analytics-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55433/fintech_test';
const BASE = '/api/v1/dashboard';
const METRICS_BASE = '/api/v1/metrics';

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
let analytics: AnalyticsService;
let authHeader = ''; // Bearer token for an operator with customers.read

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  // Integration tests don't verify rate-limiting; disable it (mirrors the other write int-specs).
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55433:5432 postgres:16-alpine`,
  );
  await waitForPostgres();

  // Foundation schema from the Prisma model, then the analytics objects Prisma can't express.
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.register(fastifyCookie); // refresh-token httpOnly cookie; mirrors main.ts
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  analytics = app.get(AnalyticsService);

  for (const statement of ANALYTICS_DDL) {
    await prisma.$executeRawUnsafe(statement);
  }

  // /dashboard/* is gated by customers.read — seed an operator and log in.
  const password = 'Test-Passw0rd!';
  const userId = uuidv7();
  const roleId = uuidv7();
  const permId = uuidv7();
  await prisma.user.create({
    data: { id: userId, email: 'operator@example.com', passwordHash: await hash(password) },
  });
  await prisma.role.create({ data: { id: roleId, name: 'operator' } });
  await prisma.permission.create({ data: { id: permId, code: 'customers.read' } });
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

/** Creates a customer with explicit KYC/status/DOB; returns its id. */
async function seedCustomer(opts: {
  kycStatus: KycStatus;
  status: CustomerStatus;
  birthYear?: number;
  email?: string;
  phone?: string;
}): Promise<string> {
  const id = uuidv7();
  await prisma.customer.create({
    data: {
      id,
      fullName: 'Test Customer',
      email: opts.email ?? `${id}@example.com`,
      phone: opts.phone ?? null,
      kycStatus: opts.kycStatus,
      status: opts.status,
      dateOfBirth: opts.birthYear ? new Date(Date.UTC(opts.birthYear, 0, 1)) : null,
    },
  });
  return id;
}

/** GET helper that attaches the operator Bearer token (the dashboard routes are gated). */
const authedGet = (path: string) =>
  request(app.getHttpServer())
    .get(path)
    .set('Authorization', authHeader);

describe('Dashboard aggregates — zero customers (integration)', () => {
  beforeAll(async () => {
    await analytics.refreshMaterializedViews();
  });

  it('summary returns zeros and a null ageStats', async () => {
    const res = await authedGet(`${BASE}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalCustomers).toBe(0);
    expect(res.body.data.activeCount).toBe(0);
    expect(res.body.data.activeRate).toBe(0);
    expect(res.body.data.ageStats).toBeNull();
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('kyc-distribution is zero-filled across every enum value, total 0', async () => {
    const res = await authedGet(`${BASE}/kyc-distribution`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.items).toHaveLength(Object.values(KycStatus).length);
    expect(res.body.data.items.every((i: { count: number }) => i.count === 0)).toBe(true);
    expect(res.body.data.asOf).toBeDefined();
  });

  it('latest-customer is empty (200, data null) when no customers exist', async () => {
    const res = await authedGet(`${BASE}/latest-customer`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe('Dashboard read path is live', () => {
  // A creation / soft-delete must move the summary count on the next request WITHOUT a materialized-
  // view refresh — this is the regression this task fixes (dev had no cron, so the MV was frozen).
  it('#L1 creating a customer increments getSummary().totalCustomers by 1, NO MV refresh', async () => {
    const before = (await analytics.getSummary()).totalCustomers;
    const id = await seedCustomer({ kycStatus: 'VERIFIED', status: 'ACTIVE' });
    // Intentionally NOT calling analytics.refreshMaterializedViews() here.
    const after = (await analytics.getSummary()).totalCustomers;
    expect(after).toBe(before + 1);

    // Soft-delete (mirrors customers.service: set deleted_at) returns the count to baseline, again
    // with no refresh — proving deleted_at IS NULL is honoured live.
    await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
    const afterDelete = (await analytics.getSummary()).totalCustomers;
    expect(afterDelete).toBe(before);
  });

  it('#L2 KYC distribution total tracks the live summary total without a refresh', async () => {
    const id = await seedCustomer({ kycStatus: 'PENDING', status: 'INACTIVE' });
    const [summary, dist] = await Promise.all([
      analytics.getSummary(),
      analytics.getKycDistribution(),
    ]);
    expect(dist.total).toBe(summary.totalCustomers); // live, both read base table at request time
    await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
  });
});

describe('Dashboard aggregates — populated with >60 customers (integration)', () => {
  // Deterministic seed: 65 customers (guards the old 60 cap).
  const KYC_PLAN: Array<[KycStatus, number]> = [
    ['VERIFIED', 30],
    ['PENDING', 10],
    ['IN_REVIEW', 8],
    ['NOT_STARTED', 7],
    ['REJECTED', 6],
    ['EXPIRED', 4],
  ];
  const TOTAL = 65;
  const ACTIVE = 50; // first 50 ACTIVE; next 10 INACTIVE; last 5 CLOSED ⇒ inactive (non-active) = 15
  let lastCustomerId = '';

  beforeAll(async () => {
    const kycList = KYC_PLAN.flatMap(([status, n]) => Array.from({ length: n }, () => status));
    expect(kycList).toHaveLength(TOTAL);

    for (let i = 0; i < TOTAL; i++) {
      const status: CustomerStatus = i < 50 ? 'ACTIVE' : i < 60 ? 'INACTIVE' : 'CLOSED';
      lastCustomerId = await seedCustomer({
        kycStatus: kycList[i],
        status,
        birthYear: 1986 + (i % 11), // ages 30..40 given the 2026 clock
      });
    }

    // Give the most-recently-created customer contact details + a wallet to exercise masking and
    // the populated wallet path. (Sequential creation ⇒ this row has the max updated_at.)
    await prisma.customer.update({
      where: { id: lastCustomerId },
      data: { email: 'jane.doe@example.com', phone: '+90 532 123 4567' },
    });
    const accountId = uuidv7();
    const walletId = uuidv7();
    await prisma.account.create({ data: { id: accountId, customerId: lastCustomerId, type: 'WALLET', currency: 'TRY' } });
    await prisma.wallet.create({ data: { id: walletId, accountId, currency: 'TRY' } });
    await prisma.walletBalance.create({ data: { walletId, balanceMinor: 125_000n, availableBalanceMinor: 125_000n } });

    await analytics.refreshMaterializedViews();
  }, 120_000);

  it('#1 summary counts are correct above 60 customers (guards the 60-record cap)', async () => {
    const res = await authedGet(`${BASE}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalCustomers).toBe(TOTAL);
    expect(res.body.data.activeCount).toBe(ACTIVE);
    expect(res.body.data.inactiveCount).toBe(TOTAL - ACTIVE);
    expect(res.body.data.activeRate).toBeCloseTo(76.9, 1);
    expect(res.body.data.ageStats).not.toBeNull();
    const { min, avg, max } = res.body.data.ageStats;
    expect(min).toBeLessThanOrEqual(avg);
    expect(avg).toBeLessThanOrEqual(max);
    expect(min).toBeGreaterThanOrEqual(25);
    expect(max).toBeLessThanOrEqual(50);
  });

  it('#2 kyc-distribution: every enum present, counts match, total = summary.total, percents ~100', async () => {
    const [dist, summary] = await Promise.all([
      authedGet(`${BASE}/kyc-distribution`),
      authedGet(`${BASE}/summary`),
    ]);
    expect(dist.status).toBe(200);
    expect(dist.body.data.items).toHaveLength(Object.values(KycStatus).length);
    expect(dist.body.data.total).toBe(TOTAL);
    expect(dist.body.data.total).toBe(summary.body.data.totalCustomers);

    const counts = new Map<string, number>(
      dist.body.data.items.map((i: { status: string; count: number }) => [i.status, i.count]),
    );
    for (const [status, n] of KYC_PLAN) expect(counts.get(status)).toBe(n);

    const percentSum = dist.body.data.items.reduce((s: number, i: { percent: number }) => s + i.percent, 0);
    expect(percentSum).toBeGreaterThan(99);
    expect(percentSum).toBeLessThan(101);
  });

  it('#3 asOf is within the freshness window', async () => {
    const before = Date.now() - 5 * 60_000;
    const res = await authedGet(`${BASE}/summary`);
    const asOf = new Date(res.body.data.asOf).getTime();
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('#6 latest-customer returns the max-updatedAt customer, masked, with no raw PII', async () => {
    const res = await authedGet(`${BASE}/latest-customer`);
    expect(res.status).toBe(200);
    expect(res.body.data.customer.id).toBe(lastCustomerId);
    // fullName is masked at source — seeded 'Test Customer' ⇒ 'Test C***'.
    expect(res.body.data.customer.fullName).toBe('Test C***');
    expect(res.body.data.customer.email).toBe('j***@e***.com');
    expect(res.body.data.customer.phone).toBe('*** *** 4567');
    expect(res.body.data.wallet).toEqual({ currency: 'TRY', balanceMinor: '125000' });

    // No raw PII fields leak through the masked card.
    const raw = JSON.stringify(res.body.data);
    expect(raw).not.toContain('jane.doe@example.com');
    expect(raw).not.toContain('123 4567');
    // The raw surname must never reach the wire.
    expect(raw).not.toContain('Customer');
    expect(res.body.data.customer.dateOfBirth).toBeUndefined();
    expect(res.body.data.customer.nationalIdLast4).toBeUndefined();
  });
});

describe('metric_daily rollup — idempotency (integration)', () => {
  it('#5 running the daily rollup twice for one date leaves one row and bumps updated_at', async () => {
    const bucket = '2026-06-07';
    await analytics.rollupDailyMetrics(bucket);
    const first = await prisma.$queryRawUnsafe<Array<{ updated_at: Date }>>(
      `SELECT updated_at FROM metric_daily WHERE metric_key = 'customers.total' AND bucket_date = '${bucket}'::date`,
    );
    await new Promise((r) => setTimeout(r, 25));
    await analytics.rollupDailyMetrics(bucket);
    const second = await prisma.$queryRawUnsafe<Array<{ updated_at: Date }>>(
      `SELECT updated_at FROM metric_daily WHERE metric_key = 'customers.total' AND bucket_date = '${bucket}'::date`,
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1); // ON CONFLICT overwrote — no duplicate
    expect(new Date(second[0].updated_at).getTime()).toBeGreaterThan(new Date(first[0].updated_at).getTime());

    const all = await prisma.$queryRawUnsafe<Array<{ metric_key: string }>>(
      `SELECT metric_key FROM metric_daily WHERE bucket_date = '${bucket}'::date`,
    );
    expect(all.map((r) => r.metric_key).sort()).toEqual(
      [
        'customers.active',
        'customers.total',
        'customers_active_total_daily',
        'customers_new_daily',
        'transactions_count_daily',
      ].sort(),
    );
  });

  it('#5b exposes the new daily metrics endpoint with the standard envelope', async () => {
    const bucket = '2026-06-07';
    await analytics.rollupDailyMetrics(bucket);

    const res = await authedGet(
      `${METRICS_BASE}/daily?metric=customers_active_total_daily&from=${bucket}&to=${bucket}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      metric: 'customers_active_total_daily',
      items: [{ date: bucket, value: '50' }],
      asOf: expect.any(String),
    });
    expect(res.body.meta.correlationId).toBeDefined();
  });
});
