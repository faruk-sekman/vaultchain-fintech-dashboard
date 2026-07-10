/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration test for the tamper-evident audit chain against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves: appends link (prev_hash == previous entry_hash, row 0 ==
 * genesis seed), the stored entry_hash recomputes from canonical(payload), and any tampering breaks
 * the recomputation (matrix #6).
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port. Excluded from the unit run.
 */
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { execSync } from 'node:child_process';
import { uuidv7 } from '../util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AUDIT_GENESIS_SEED, AuditService, computeEntryHash } from './audit.service';

const CONTAINER = 'ftd-audit-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55437/fintech_test';

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
let audit: AuditService;
let actorUserId = '';

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  // Integration tests don't verify rate-limiting; disable it (mirrors the other write int-specs).
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
  await app.init();

  prisma = app.get(PrismaService);
  audit = app.get(AuditService);
  actorUserId = uuidv7();
  await prisma.user.create({ data: { id: actorUserId, email: 'auditor@example.com', passwordHash: 'x' } });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

describe('Audit chain (integration)', () => {
  it('links rows from the genesis seed and each entry_hash recomputes from canonical(payload)', async () => {
    await audit.record({ actorUserId, action: 'test.one', resourceType: 'thing', resourceId: null, outcome: 'SUCCESS', context: { a: 1 } });
    await audit.record({ actorUserId, action: 'test.two', resourceType: 'thing', outcome: 'DENIED', context: { b: 'x', nested: { z: 1, a: 2 } } });
    await audit.record({ actorUserId, action: 'test.three', resourceType: 'thing', outcome: 'SUCCESS' });

    const rows = await prisma.auditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(rows.length).toBe(3);

    let prev = AUDIT_GENESIS_SEED;
    for (const row of rows) {
      expect(row.prevHash).toBe(prev); // chain linkage (row 0 = genesis)
      const recomputed = computeEntryHash(row.prevHash, {
        id: row.id,
        actorUserId: row.actorUserId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId ?? null,
        outcome: row.outcome,
        context: row.maskedContextJson ?? null,
        ipHash: row.ipHash ?? null,
        correlationId: row.correlationId ?? null,
        createdAt: row.createdAt.toISOString(),
      });
      expect(recomputed).toBe(row.entryHash);
      prev = row.entryHash;
    }
  });

  it('detects tampering — changing a stored field breaks the recomputed hash', async () => {
    const row = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' } });
    expect(row).not.toBeNull();
    const tampered = computeEntryHash(row!.prevHash, {
      id: row!.id,
      actorUserId: row!.actorUserId,
      action: row!.action,
      resourceType: row!.resourceType,
      resourceId: row!.resourceId ?? null,
      outcome: 'FAIL', // ← tampered (was SUCCESS)
      context: row!.maskedContextJson ?? null,
      ipHash: row!.ipHash ?? null,
      correlationId: row!.correlationId ?? null,
      createdAt: row!.createdAt.toISOString(),
    });
    expect(tampered).not.toBe(row!.entryHash);
  });

  it('covers ip_hash and correlation_id in the hash — tampering either breaks it (DATA-003)', async () => {
    const row = await prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' } });
    expect(row).not.toBeNull();
    const base = {
      id: row!.id,
      actorUserId: row!.actorUserId,
      action: row!.action,
      resourceType: row!.resourceType,
      resourceId: row!.resourceId ?? null,
      outcome: row!.outcome,
      context: row!.maskedContextJson ?? null,
      ipHash: row!.ipHash ?? null,
      correlationId: row!.correlationId ?? null,
      createdAt: row!.createdAt.toISOString(),
    };
    // A faithful recompute matches; flipping ip_hash or correlation_id must now diverge (before the
    // fix these columns were outside the hashed payload, so a change went undetected).
    expect(computeEntryHash(row!.prevHash, base)).toBe(row!.entryHash);
    expect(computeEntryHash(row!.prevHash, { ...base, ipHash: 'tampered-ip' })).not.toBe(row!.entryHash);
    expect(computeEntryHash(row!.prevHash, { ...base, correlationId: 'tampered-corr' })).not.toBe(row!.entryHash);
  });
});
