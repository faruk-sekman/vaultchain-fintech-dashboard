/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the A15/A16 admin-approval reset-request flow against a REAL ephemeral
 * PostgreSQL 16. Proves what mocks cannot:
 *
 *  (A) A16 enumeration surface: create is ALWAYS 202 with a byte-identical data payload AND ALWAYS a
 *      Set-Cookie ftd_pwreq (existing account, unknown email, duplicate alike; httpOnly + Strict +
 *      path-scoped); a duplicate create adds NO second row; a decoy cookie polls as 'pending'; the
 *      admin fan-out lands as REAL notification rows with the masked account only.
 *  (B) permission gate: the admin queue is 401 without a token and 403 for a bearer lacking
 *      auth.password.admin_reset.
 *  (C) the FULL happy path: request → admin list (PENDING first, masked email) → approve (bearer) →
 *      status poll CLAIMS a pre-stamped 'admin_approval' challenge cookie → the EXISTING
 *      /auth/password/reset/verify sets the new password → login works with the new password and fails
 *      with the old → completedAt stamped; the spent challenge cookie is single-use; a re-poll after
 *      completion stays 'approved' and mints NO new cookie. Double-approve → 409 AlreadyDecided.
 *  (D) deny path: deny → owner polls 'denied' → the requester receives the denial receipt.
 *  (E) self-decision: an admin deciding their OWN account's request → 403 Auth.SelfResetForbidden.
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port 55443 (55432 is the Compose
 * dev DB and 55440 the ad-hoc local one — never touched here; 55433-55444 belong to the suites).
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash } from '@node-rs/argon2';
import fastifyCookie from '@fastify/cookie';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const CONTAINER = 'ftd-pwreq-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55443/fintech_test';

const CREATE = '/api/v1/auth/password/reset-request';
const STATUS = '/api/v1/auth/password/reset-request/status';
const ADMIN_LIST = '/api/v1/auth/password/reset-requests';
const VERIFY = '/api/v1/auth/password/reset/verify';
const LOGIN = '/api/v1/auth/login';

const PWREQ_COOKIE = 'ftd_pwreq';
const PWRESET_COOKIE = 'ftd_pwreset';

const ADMIN = { email: 'approver@example.com', password: 'Admin-Passw0rd-1!' };
const LIMITED = { email: 'limited-op@example.com', password: 'Limit-Passw0rd-1!' };
const REQ_USER = { email: 'norma-op@example.com', password: 'Old-Passw0rd-11!' }; // the no-MFA persona
const ENUM_USER = { email: 'enum-op@example.com', password: 'Enum-Passw0rd-1!' };
const DENY_USER = { email: 'deny-op@example.com', password: 'Deny-Passw0rd-1!' };
const NEW_PASSWORD = 'New-Passw0rd-77!';

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

/** Pull a named cookie's value out of a Set-Cookie response header (or undefined). */
function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = list.find((c) => c.startsWith(`${name}=`));
  if (!match) return undefined;
  const value = match.slice(`${name}=`.length).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

let app: NestFastifyApplication;
let prisma: PrismaService;
let adminId: string;
let reqUserId: string;
let denyUserId: string;

/** Seed an ACTIVE user; when permissionCodes are given, a dedicated role grants them. */
async function seedUser(
  email: string,
  password: string,
  permissionCodes: string[] = [],
  displayName?: string,
): Promise<string> {
  const userId = uuidv7();
  await prisma.user.create({
    data: { id: userId, email: email.toLowerCase(), passwordHash: await hash(password), displayName },
  });
  if (permissionCodes.length > 0) {
    const roleId = uuidv7();
    await prisma.role.create({ data: { id: roleId, name: `role-${userId}` } });
    await prisma.userRole.create({ data: { userId, roleId } });
    for (const code of permissionCodes) {
      const existing = await prisma.permission.findUnique({ where: { code } });
      const permission = existing ?? (await prisma.permission.create({ data: { id: uuidv7(), code } }));
      await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    }
  }
  return userId;
}

const login = (email: string, password: string) => request(app.getHttpServer()).post(LOGIN).send({ email, password });
const createRequest = (email: string) => request(app.getHttpServer()).post(CREATE).send({ email });
const pollStatus = (cookie: string) =>
  request(app.getHttpServer()).post(STATUS).set('Cookie', `${PWREQ_COOKIE}=${cookie}`);
const bearerOf = async (email: string, password: string): Promise<string> =>
  (await login(email, password)).body.data.accessToken as string;

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1'; // the 3/min create cap would fail a suite that creates repeatedly

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55443:5432 postgres:16-alpine`,
  );
  await waitForPostgres();
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.register(fastifyCookie);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  adminId = await seedUser(ADMIN.email, ADMIN.password, ['auth.password.admin_reset'], 'Admin Won');
  await seedUser(LIMITED.email, LIMITED.password, ['transactions.read']); // deliberately NOT admin_reset
  reqUserId = await seedUser(REQ_USER.email, REQ_USER.password); // plain, NO MFA — the A15 persona
  await seedUser(ENUM_USER.email, ENUM_USER.password);
  denyUserId = await seedUser(DENY_USER.email, DENY_USER.password);
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

describe('(A) POST reset-request — A16 enumeration surface', () => {
  it('existing / unknown / duplicate emails: byte-identical 202 payload + Set-Cookie ftd_pwreq on ALL', async () => {
    const existing = await createRequest(ENUM_USER.email); //   creates the row
    const unknown = await createRequest('ghost-nobody@example.com');
    const duplicate = await createRequest(ENUM_USER.email); //  open request + cooldown → silently absorbed

    for (const res of [existing, unknown, duplicate]) {
      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe('reset_request_received');
      expect(cookieFrom(res, PWREQ_COOKIE)).toMatch(/^pwq_/);
    }
    // Byte-identical data payloads (meta.correlationId is request-scoped randomness, not account-derived).
    expect(JSON.stringify(existing.body.data)).toBe(JSON.stringify(unknown.body.data));
    expect(JSON.stringify(unknown.body.data)).toBe(JSON.stringify(duplicate.body.data));

    // Cookie attributes mirror the challenge cookie: httpOnly, Strict, path-scoped to the auth API.
    const setCookie = String(existing.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('the duplicate create added NO second row (one open request per account)', async () => {
    const enumUser = await prisma.user.findUnique({ where: { email: ENUM_USER.email }, select: { id: true } });
    expect(await prisma.passwordResetRequest.count({ where: { userId: enumUser!.id } })).toBe(1);
  });

  it("an unknown-email DECOY cookie polls as 'pending' (indistinguishable) — and never 401/404", async () => {
    const decoy = cookieFrom(await createRequest('ghost-2@example.com'), PWREQ_COOKIE)!;
    const res = await pollStatus(decoy);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'pending' });

    const noCookie = await request(app.getHttpServer()).post(STATUS);
    expect(noCookie.status).toBe(200);
    expect(noCookie.body.data).toEqual({ status: 'pending' });
  });

  it('the create fanned out a REAL notification to the admin — masked account only, deep link to the request', async () => {
    const enumUser = await prisma.user.findUnique({ where: { email: ENUM_USER.email }, select: { id: true } });
    const req = await prisma.passwordResetRequest.findFirst({ where: { userId: enumUser!.id } });
    const note = await prisma.notification.findFirst({
      where: { recipientUserId: adminId, titleKey: 'notifications.security.resetRequestCreated.title' },
    });
    expect(note).toBeTruthy();
    expect(note!.resourceType).toBe('password_reset_request');
    expect(note!.resourceId).toBe(req!.id);
    const params = note!.paramsJson as { account: string };
    expect(params.account).toContain('***');
    expect(JSON.stringify(note)).not.toContain(ENUM_USER.email); // the raw email NEVER reaches the row
  });
});

describe('(B) admin queue — permission gate', () => {
  it('401 without a token; 403 for a bearer lacking auth.password.admin_reset', async () => {
    const anon = await request(app.getHttpServer()).get(ADMIN_LIST);
    expect(anon.status).toBe(401);

    const limited = await bearerOf(LIMITED.email, LIMITED.password);
    const res = await request(app.getHttpServer()).get(ADMIN_LIST).set('Authorization', `Bearer ${limited}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });
});

describe('(C) happy path — request → approve → claim → verify → fresh login', () => {
  let pwreqCookie: string;
  let requestId: string;
  let pwresetCookie: string;

  it('the no-MFA operator files a request and the admin sees it PENDING with a masked account', async () => {
    pwreqCookie = cookieFrom(await createRequest(REQ_USER.email), PWREQ_COOKIE)!;
    expect(pwreqCookie).toMatch(/^pwq_/);

    const admin = await bearerOf(ADMIN.email, ADMIN.password);
    const list = await request(app.getHttpServer()).get(ADMIN_LIST).set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);
    expect(list.body.data[0].status).toBe('PENDING'); // PENDING first (enum order)
    const mine = (list.body.data as Array<{ id: string; account: { emailMasked: string } }>).find(
      (item) => item.account.emailMasked === 'n***@e***.com',
    );
    expect(mine).toBeTruthy();
    requestId = mine!.id;
    expect(JSON.stringify(list.body)).not.toContain(REQ_USER.email); // never the raw email
  });

  it('the owner polls pending; the admin detail carries the coarse device metadata', async () => {
    expect((await pollStatus(pwreqCookie)).body.data).toEqual({ status: 'pending' });

    const admin = await bearerOf(ADMIN.email, ADMIN.password);
    const detail = await request(app.getHttpServer())
      .get(`${ADMIN_LIST}/${requestId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: requestId, status: 'PENDING', deviceSummary: expect.any(String) });
    expect(detail.body.data.ipPrefix === null || /\/24|\/48/.test(detail.body.data.ipPrefix)).toBe(true);
  });

  it('approve (bearer admin) returns the refreshed detail; a second approve is 409 AlreadyDecided', async () => {
    const admin = await bearerOf(ADMIN.email, ADMIN.password);
    const approve = await request(app.getHttpServer())
      .post(`${ADMIN_LIST}/${requestId}/approve`)
      .set('Authorization', `Bearer ${admin}`);
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');
    expect(approve.body.data.decidedByName).toBe('Admin Won');
    expect(approve.body.data.decidedAt).toBeTruthy();

    const again = await request(app.getHttpServer())
      .post(`${ADMIN_LIST}/${requestId}/approve`)
      .set('Authorization', `Bearer ${admin}`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('Auth.ResetRequestAlreadyDecided');
  });

  it("the owner's poll now CLAIMS: 'approved' + a ftd_pwreset cookie pre-stamped 'admin_approval'", async () => {
    const res = await pollStatus(pwreqCookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'approved' });
    pwresetCookie = cookieFrom(res, PWRESET_COOKIE)!;
    expect(pwresetCookie).toMatch(/^pwr_/);

    // DB truth: the request remembers the claimed challenge; the challenge is factor-pre-stamped.
    const row = await prisma.passwordResetRequest.findUnique({ where: { id: requestId } });
    expect(row!.challengeId).toBeTruthy();
    const challenge = await prisma.passwordResetChallenge.findUnique({ where: { id: row!.challengeId! } });
    expect(challenge!.factorVerifiedAt).toBeTruthy();
    expect(challenge!.factorMethod).toBe('admin_approval');
    expect(challenge!.userId).toBe(reqUserId);
  });

  it('the EXISTING /reset/verify finishes with the new password; old login fails, new works; completedAt stamped', async () => {
    const verify = await request(app.getHttpServer())
      .post(VERIFY)
      .set('Cookie', `${PWRESET_COOKIE}=${pwresetCookie}`)
      .send({ newPassword: NEW_PASSWORD });
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('reset_complete');

    expect((await login(REQ_USER.email, REQ_USER.password)).status).toBe(401); // old password dead
    const fresh = await login(REQ_USER.email, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.status).toBe('authenticated');

    const row = await prisma.passwordResetRequest.findUnique({ where: { id: requestId } });
    expect(row!.completedAt).toBeTruthy();
    expect(row!.status).toBe('APPROVED');
  });

  it('the spent challenge cookie is single-use; a re-poll stays approved and mints NO new cookie', async () => {
    const replay = await request(app.getHttpServer())
      .post(VERIFY)
      .set('Cookie', `${PWRESET_COOKIE}=${pwresetCookie}`)
      .send({ newPassword: 'Another-Passw0rd-9!' });
    expect(replay.status).toBe(401); // consumed → the guard fail-closes

    const poll = await pollStatus(pwreqCookie);
    expect(poll.body.data).toEqual({ status: 'approved' });
    expect(cookieFrom(poll, PWRESET_COOKIE)).toBeUndefined(); // completed → no re-mint
  });
});

describe('(D) deny path', () => {
  it("deny → the owner polls 'denied' → the requester holds a denial receipt notification", async () => {
    const cookie = cookieFrom(await createRequest(DENY_USER.email), PWREQ_COOKIE)!;
    const row = await prisma.passwordResetRequest.findFirst({
      where: { userId: denyUserId, status: 'PENDING' },
    });

    const admin = await bearerOf(ADMIN.email, ADMIN.password);
    const deny = await request(app.getHttpServer())
      .post(`${ADMIN_LIST}/${row!.id}/deny`)
      .set('Authorization', `Bearer ${admin}`);
    expect(deny.status).toBe(200);
    expect(deny.body.data.status).toBe('DENIED');

    const poll = await pollStatus(cookie);
    expect(poll.body.data).toEqual({ status: 'denied' });
    expect(cookieFrom(poll, PWRESET_COOKIE)).toBeUndefined(); // a denial never mints a challenge

    const receipt = await prisma.notification.findFirst({
      where: { recipientUserId: denyUserId, titleKey: 'notifications.security.resetRequestDenied.title' },
    });
    expect(receipt).toBeTruthy();
    expect(receipt!.severity).toBe('warning');
  });
});

describe('(E) self-decision forbidden', () => {
  it("an admin deciding their OWN account's request → 403 Auth.SelfResetForbidden", async () => {
    await createRequest(ADMIN.email);
    const row = await prisma.passwordResetRequest.findFirst({ where: { userId: adminId, status: 'PENDING' } });
    expect(row).toBeTruthy();

    const admin = await bearerOf(ADMIN.email, ADMIN.password);
    const res = await request(app.getHttpServer())
      .post(`${ADMIN_LIST}/${row!.id}/approve`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.SelfResetForbidden');
  });
});
