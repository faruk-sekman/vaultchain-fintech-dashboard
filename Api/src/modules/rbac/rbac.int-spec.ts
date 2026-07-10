/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for RBAC administration against a REAL ephemeral PostgreSQL 16
 * (Docker CLI). Proves: permission-gated reads/mutations, the self-escalation guard (an actor can't
 * grant a permission — directly or via a role — that they don't hold), role/permission assignment,
 * and that every mutation writes an audit_logs row (SUCCESS / DENIED).
 *
 * Also proves the admin-only paged `GET /users` — the permission gate (users.manage
 * admin 200 vs a non-users.manage caller 403), pagination + the rejected out-of-range page size, and
 * the PII-MINIMAL field allowlist (no password/secret/email leaks).
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

const CONTAINER = 'ftd-rbac-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55435/fintech_test';
const ROLES = '/api/v1/roles';
const PERMISSIONS = '/api/v1/permissions';
const USERS = '/api/v1/users';

const ADMIN = { email: 'admin@example.com', password: 'Test-Passw0rd!' };
const LIMITED = { email: 'limited@example.com', password: 'Test-Passw0rd!' };

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
let limitedAuth = '';
let targetUserId = '';
let customersReadPermId = '';
let transactionsCreatePermId = '';

async function ensurePermission(code: string): Promise<string> {
  const existing = await prisma.permission.findUnique({ where: { code } });
  if (existing) return existing.id;
  const created = await prisma.permission.create({ data: { id: uuidv7(), code } });
  return created.id;
}

/** Seeds a user with a dedicated role granting the given permission codes; returns the user id. */
async function seedUser(email: string, password: string, codes: string[], displayName?: string): Promise<string> {
  const userId = uuidv7();
  const roleId = uuidv7();
  await prisma.user.create({
    data: { id: userId, email: email.toLowerCase(), passwordHash: await hash(password), displayName: displayName ?? null },
  });
  await prisma.role.create({ data: { id: roleId, name: `role-${userId}` } });
  await prisma.userRole.create({ data: { userId, roleId } });
  for (const code of codes) {
    await prisma.rolePermission.create({ data: { roleId, permissionId: await ensurePermission(code) } });
  }
  return userId;
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
      `-e POSTGRES_DB=fintech_test -p 55435:5432 postgres:16-alpine`,
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
  // Admin can manage RBAC + holds customers.read, but deliberately NOT transactions.create.
  await seedUser(ADMIN.email, ADMIN.password, ['roles.read', 'roles.manage', 'permissions.manage', 'users.manage', 'customers.read'], 'Ada Admin');
  await seedUser(LIMITED.email, LIMITED.password, ['roles.read'], 'Lee Limited'); // can read roles, NOT users.manage
  targetUserId = await seedUser('target@example.com', ADMIN.password, [], 'Tom Target');

  customersReadPermId = await ensurePermission('customers.read');
  transactionsCreatePermId = await ensurePermission('transactions.create'); // exists in catalog; admin lacks it

  adminAuth = `Bearer ${(await login(ADMIN)).body.data.accessToken}`;
  limitedAuth = `Bearer ${(await login(LIMITED)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

describe('RBAC reads (integration)', () => {
  it('GET /roles lists roles (roles.read)', async () => {
    const res = await request(app.getHttpServer()).get(ROLES).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /permissions returns the catalog', async () => {
    const res = await request(app.getHttpServer()).get(PERMISSIONS).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    const codes = res.body.data.items.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['customers.read', 'transactions.create']));
  });
});

describe('GET /users — admin-only paged list (integration)', () => {
  it('admin (users.manage) gets a paged PII-minimal list', async () => {
    const res = await request(app.getHttpServer()).get(USERS).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3); // admin, limited, target
    expect(res.body.page).toMatchObject({ number: 1, size: 25 });
    expect(res.body.page.totalItems).toBeGreaterThanOrEqual(3);

    // FIELD ALLOWLIST: id/displayName/status/roles + a MASKED email + lockout telemetry (locked /
    // failedLoginCount / lastLoginAt) — the owner-approved operator-status-panel shape.
    // NEVER a raw email/phone, password hash, or MFA secret.
    for (const row of res.body.data) {
      expect(Object.keys(row).sort()).toEqual([
        'displayName',
        'emailMasked',
        'failedLoginCount',
        'id',
        'lastLoginAt',
        'locked',
        'roles',
        'status',
      ]);
      expect(row.emailMasked).toMatch(/\*/); // masked server-side (e.g. m***@s***.local) — never a raw address
      expect(row).not.toHaveProperty('passwordHash');
      expect(row).not.toHaveProperty('email'); // only the masked variant is exposed
      expect(row).not.toHaveProperty('totpSecretEnc');
      expect(row).not.toHaveProperty('phone');
      expect(Array.isArray(row.roles)).toBe(true);
    }
    // And no PII value (a seeded email/secret) appears anywhere in the serialized body.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('admin@example.com');
    expect(body).not.toContain('password_hash');
  });

  it('a non-users.manage caller (auditor/operator-like) gets 403 (separation of duties)', async () => {
    const res = await request(app.getHttpServer()).get(USERS).set('Authorization', limitedAuth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });

  it('401s without a token', async () => {
    const res = await request(app.getHttpServer()).get(USERS);
    expect(res.status).toBe(401);
  });

  it('honors page[size] and reports totalPages', async () => {
    const res = await request(app.getHttpServer()).get(`${USERS}?page[number]=1&page[size]=2`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.page.size).toBe(2);
    expect(res.body.page.totalPages).toBeGreaterThanOrEqual(2);
  });

  it('rejects an out-of-range page[size] with a 400 (bounds bulk enumeration)', async () => {
    const res = await request(app.getHttpServer()).get(`${USERS}?page[size]=101`).set('Authorization', adminAuth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Validation.Failed');
  });

  it('filters by display name (filter[q], case-insensitive)', async () => {
    const res = await request(app.getHttpServer()).get(`${USERS}?filter[q]=target`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe(targetUserId);
    expect(res.body.data[0].displayName).toBe('Tom Target');
  });
});

describe('RBAC mutations + self-escalation (integration)', () => {
  let supportRoleId = '';

  beforeAll(async () => {
    const res = await request(app.getHttpServer()).post(ROLES).set('Authorization', adminAuth).send({ name: 'support' });
    expect(res.status).toBe(201);
    supportRoleId = res.body.data.id;
  });

  it('grants a permission the actor holds (customers.read) → 200', async () => {
    const res = await request(app.getHttpServer())
      .post(`${ROLES}/${supportRoleId}/permissions`)
      .set('Authorization', adminAuth)
      .send({ permissionId: customersReadPermId });
    expect(res.status).toBe(201);

    const roles = await request(app.getHttpServer()).get(ROLES).set('Authorization', adminAuth);
    const support = roles.body.data.items.find((r: { id: string }) => r.id === supportRoleId);
    expect(support.permissions).toContain('customers.read');
  });

  it('blocks self-escalation: granting transactions.create (actor lacks it) → 403 + DENIED audit', async () => {
    const res = await request(app.getHttpServer())
      .post(`${ROLES}/${supportRoleId}/permissions`)
      .set('Authorization', adminAuth)
      .send({ permissionId: transactionsCreatePermId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Rbac.SelfEscalation');

    const denied = await prisma.auditLog.count({ where: { action: 'role.grant_permission', outcome: 'DENIED' } });
    expect(denied).toBeGreaterThanOrEqual(1);
  });

  it('assigns a role whose permissions the actor holds → 200', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/users/${targetUserId}/roles`)
      .set('Authorization', adminAuth)
      .send({ roleId: supportRoleId });
    expect(res.status).toBe(201);
    const link = await prisma.userRole.findUnique({ where: { userId_roleId: { userId: targetUserId, roleId: supportRoleId } } });
    expect(link).not.toBeNull();
  });

  it('writes a SUCCESS audit row for the grant', async () => {
    const ok = await prisma.auditLog.count({ where: { action: 'role.grant_permission', outcome: 'SUCCESS' } });
    expect(ok).toBeGreaterThanOrEqual(1);
  });
});

describe('RBAC enforcement (integration)', () => {
  it('403s a manage action for a caller without the permission', async () => {
    const res = await request(app.getHttpServer()).post(ROLES).set('Authorization', limitedAuth).send({ name: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });

  it('401s without a token', async () => {
    const res = await request(app.getHttpServer()).get(ROLES);
    expect(res.status).toBe(401);
  });
});
