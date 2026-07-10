/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for auth core + enforcement against a REAL ephemeral
 * PostgreSQL 16 (Docker CLI). Proves: Argon2 login (happy + generic failure, no enumeration),
 * /auth/me, and the guard matrix on a gated endpoint — 401 (no/!valid token) and 403 (valid token
 * lacking the permission). The 200-with-permission path is proven by analytics.int-spec.
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port (no collision with the
 * ledger/analytics suites). Excluded from the default unit run by the `.int-spec.ts` suffix.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash } from '@node-rs/argon2';
import fastifyCookie from '@fastify/cookie';
import { execSync } from 'node:child_process';
import { generate as generateTotpToken } from 'otplib';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TotpService } from '../mfa/totp.service';

const REFRESH_COOKIE = 'ftd_refresh';

/** Pull a named cookie's value out of a Set-Cookie response header. */
function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = list.find((c) => c.startsWith(`${name}=`));
  if (!match) return undefined;
  const value = match.slice(`${name}=`.length).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

/** Pull the `ftd_refresh` cookie value out of a Set-Cookie response header. */
function refreshCookieFrom(res: request.Response): string | undefined {
  return cookieFrom(res, REFRESH_COOKIE);
}

const CONTAINER = 'ftd-auth-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55434/fintech_test';
const LOGIN = '/api/v1/auth/login';
const ME = '/api/v1/auth/me';
const GATED = '/api/v1/dashboard/summary'; // requires customers.read — used to exercise the guards
const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';

const OPERATOR = { email: 'operator@example.com', password: 'Test-Passw0rd!' };
const LIMITED = { email: 'limited@example.com', password: 'Test-Passw0rd!' };
const LOCKME = { email: 'lockme@example.com', password: 'Test-Passw0rd!' };
const MFA_USER = { email: 'mfa-remember@example.com', password: 'Test-Passw0rd!' };

const MFA_VERIFY = '/api/v1/auth/mfa/verify';
const DEVICES = '/api/v1/auth/mfa/devices';

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

/** Seeds a user with a dedicated role granting the given permission codes. */
async function seedUser(email: string, password: string, permissionCodes: string[]): Promise<void> {
  const userId = uuidv7();
  const roleId = uuidv7();
  await prisma.user.create({
    data: { id: userId, email: email.toLowerCase(), passwordHash: await hash(password) },
  });
  await prisma.role.create({ data: { id: roleId, name: `role-${userId}` } });
  await prisma.userRole.create({ data: { userId, roleId } });
  for (const code of permissionCodes) {
    const existing = await prisma.permission.findUnique({ where: { code } });
    const permission = existing ?? (await prisma.permission.create({ data: { id: uuidv7(), code } }));
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  }
}

const login = (email: string, password: string) =>
  request(app.getHttpServer()).post(LOGIN).send({ email, password });

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1'; // many logins from one test IP would otherwise hit the 10/min cap
  process.env.MFA_REMEMBER_DEVICE_ENABLED = 'true'; // the A17 remember-device lifecycle suite needs the flag on

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55434:5432 postgres:16-alpine`,
  );
  await waitForPostgres();
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.register(fastifyCookie); // refresh token rides in the httpOnly cookie
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  await seedUser(OPERATOR.email, OPERATOR.password, ['customers.read', 'transactions.create']);
  await seedUser(LIMITED.email, LIMITED.password, ['transactions.read']); // deliberately NOT customers.read
  await seedUser(LOCKME.email, LOCKME.password, ['customers.read']); // dedicated user for the lockout test

  // A17 remember-device lifecycle: an MFA-confirmed user with a REAL encrypted TOTP secret.
  const totp = app.get(TotpService);
  mfaSecret = totp.generateSecret();
  const mfaUserId = uuidv7();
  await prisma.user.create({
    data: {
      id: mfaUserId,
      email: MFA_USER.email,
      passwordHash: await hash(MFA_USER.password),
      mfaEnabled: true,
      mfaConfirmedAt: new Date(),
      totpSecretEnc: await totp.encryptSecret(mfaSecret, mfaUserId),
      status: 'ACTIVE',
    },
  });
}, 180_000);

let mfaSecret = '';

/** Mint a currently-valid 6-digit TOTP code for the seeded MFA user (same params as TotpService). */
const totpCode = (): Promise<string> =>
  generateTotpToken({ secret: mfaSecret, period: 30, digits: 6, algorithm: 'sha1' });

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

describe('POST /auth/login (integration)', () => {
  it('issues a 15-min token + effective permissions, never echoes the hash', async () => {
    const res = await login(OPERATOR.email, OPERATOR.password);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.tokenType).toBe('Bearer');
    expect(res.body.data.expiresIn).toBe(900);
    expect(res.body.data.permissions).toEqual(['customers.read', 'transactions.create']);
    // The refresh token rides in the httpOnly cookie, NOT the response body.
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(refreshCookieFrom(res)).toMatch(/^rt_/);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/i);
    expect(res.body.data.user.email).toBe('o***@e***.com'); // masked profile (spec §1; AUTH email-mask fix)
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$argon2/);
  });

  it('rejects a wrong password with a generic 401 (no enumeration)', async () => {
    const res = await login(OPERATOR.email, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.InvalidCredentials');
  });

  it('rejects an unknown email with the same generic 401', async () => {
    const res = await login('nobody@example.com', OPERATOR.password);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.InvalidCredentials');
  });
});

describe('GET /auth/me (integration)', () => {
  it('returns the principal + permissions for a valid token', async () => {
    const token = (await login(OPERATOR.email, OPERATOR.password)).body.data.accessToken;
    const res = await request(app.getHttpServer()).get(ME).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('o***@e***.com'); // masked profile (spec §1; AUTH email-mask fix)
    expect(res.body.data.permissions).toContain('customers.read');
  });

  it('rejects a missing token (401)', async () => {
    const res = await request(app.getHttpServer()).get(ME);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.TokenMissing');
  });

  it('rejects a malformed token (401)', async () => {
    const res = await request(app.getHttpServer()).get(ME).set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.TokenInvalid');
  });
});

describe('RBAC enforcement on a gated endpoint (integration)', () => {
  it('401s a gated route with no token', async () => {
    const res = await request(app.getHttpServer()).get(GATED);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.TokenMissing');
  });

  it('403s a valid token that lacks the required permission', async () => {
    const token = (await login(LIMITED.email, LIMITED.password)).body.data.accessToken;
    const res = await request(app.getHttpServer()).get(GATED).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });
});

/** Present a refresh token by sending it in the `ftd_refresh` cookie (the new transport). */
const refresh = (refreshToken: string) =>
  request(app.getHttpServer()).post(REFRESH).set('Cookie', `${REFRESH_COOKIE}=${refreshToken}`);
/** Call /auth/refresh with NO cookie at all. */
const refreshNoCookie = () => request(app.getHttpServer()).post(REFRESH);

describe('POST /auth/refresh — rotation & reuse detection (integration)', () => {
  it('rotates: a fresh refresh token (from the cookie) yields a new access token + rotated cookie', async () => {
    const first = refreshCookieFrom(await login(OPERATOR.email, OPERATOR.password))!;
    const res = await refresh(first);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined(); // never in the body
    const rotated = refreshCookieFrom(res);
    expect(rotated).toMatch(/^rt_/);
    expect(rotated).not.toBe(first);
    expect(typeof res.body.data.accessToken).toBe('string');
  });

  it('reuse of a rotated token is detected — 401 and the whole session is revoked', async () => {
    const first = refreshCookieFrom(await login(OPERATOR.email, OPERATOR.password))!;
    const second = refreshCookieFrom(await refresh(first))!; // first now revoked

    const reuse = await refresh(first); // present the revoked token again
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('Auth.TokenReused');

    const collateral = await refresh(second); // the rotated-in token is revoked as collateral
    expect(collateral.status).toBe(401);
  });

  it('rejects an invalid refresh token (401)', async () => {
    const res = await refresh('rt_00000000-0000-7000-8000-000000000000.deadbeef');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.InvalidToken');
  });

  it('401s when no refresh cookie is present at all', async () => {
    const res = await refreshNoCookie();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.InvalidToken');
  });
});

describe('POST /auth/logout (integration)', () => {
  it('revokes the session and clears the cookie — the refresh token stops working (204 then 401)', async () => {
    const loginRes = await login(OPERATOR.email, OPERATOR.password);
    const accessToken = loginRes.body.data.accessToken;
    const refreshToken = refreshCookieFrom(loginRes)!;
    const out = await request(app.getHttpServer())
      .post(LOGOUT)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', `${REFRESH_COOKIE}=${refreshToken}`);
    expect(out.status).toBe(204);
    // The Set-Cookie header expires/clears the refresh cookie.
    expect(String(out.headers['set-cookie'])).toMatch(/ftd_refresh=;/i);

    const after = await refresh(refreshToken);
    expect(after.status).toBe(401);
  });

  it('is public + idempotent: a forged/unknown refresh cookie is a safe 204 no-op (not 401)', async () => {
    // logout is @Public (FND-011) so the SPA can clear a stale httpOnly cookie even
    // when JS holds no access token. An unparseable/unknown token revokes nothing but still clears.
    const res = await request(app.getHttpServer()).post(LOGOUT).set('Cookie', `${REFRESH_COOKIE}=rt_x.y`);
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/ftd_refresh=;/i);
  });

  it('a valid token id with the WRONG secret does not revoke the session (secret is verified)', async () => {
    const loginRes = await login(OPERATOR.email, OPERATOR.password);
    const refreshToken = refreshCookieFrom(loginRes)!;
    const id = refreshToken.slice('rt_'.length, refreshToken.indexOf('.'));
    const forged = `rt_${id}.not-the-real-secret`;

    const out = await request(app.getHttpServer()).post(LOGOUT).set('Cookie', `${REFRESH_COOKIE}=${forged}`);
    expect(out.status).toBe(204);

    // The genuine session is untouched: the real refresh token still rotates successfully.
    const after = await refresh(refreshToken);
    expect(after.status).toBe(200);
  });
});

describe('Account lockout (integration)', () => {
  it('locks after 5 failed logins — then 423 even with the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await login(LOCKME.email, 'wrong-password');
      expect(bad.status).toBe(401);
    }
    const locked = await login(LOCKME.email, LOCKME.password); // correct password, but now locked
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('Auth.AccountLocked');
  });
});

describe('Remember-device lifecycle — trust survives logout (A17, integration)', () => {
  it('verify(remember) → logout keeps ftd_remember → next login skips MFA → self-service revoke restores the challenge', async () => {
    // 1) Password login on an MFA-confirmed account → mfa_required + the ftd_mfa challenge cookie.
    const first = await login(MFA_USER.email, MFA_USER.password);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('mfa_required');
    const challenge = cookieFrom(first, 'ftd_mfa')!;
    expect(challenge).toBeTruthy();

    // 2) Verify a LIVE TOTP code with rememberDevice → session + the ftd_remember trust cookie.
    const verified = await request(app.getHttpServer())
      .post(MFA_VERIFY)
      .set('Cookie', `ftd_mfa=${challenge}`)
      .send({ code: await totpCode(), rememberDevice: true });
    expect(verified.status).toBe(200);
    expect(verified.body.data.status).toBe('authenticated');
    const remember = cookieFrom(verified, 'ftd_remember')!;
    expect(remember).toMatch(/^rd_/);
    const refreshTok = cookieFrom(verified, REFRESH_COOKIE)!;

    // 3) Logout with BOTH cookies: the session dies, but the device trust must SURVIVE — the
    //    old de-trust-on-logout made the feature unobservable (the A17 bug).
    const out = await request(app.getHttpServer())
      .post(LOGOUT)
      .set('Cookie', `${REFRESH_COOKIE}=${refreshTok}; ftd_remember=${remember}`);
    expect(out.status).toBe(204);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/ftd_refresh=;/i);
    expect(cleared).not.toMatch(/ftd_remember=;/i);

    // 4) Next password login presenting ftd_remember → FULL session immediately, no MFA step.
    const second = await request(app.getHttpServer())
      .post(LOGIN)
      .set('Cookie', `ftd_remember=${remember}`)
      .send({ email: MFA_USER.email, password: MFA_USER.password });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('authenticated');
    expect(typeof second.body.data.accessToken).toBe('string');

    // 5) The device shows in the self-service trusted list; revoke it.
    const bearer = second.body.data.accessToken as string;
    const list = await request(app.getHttpServer()).get(DEVICES).set('Authorization', `Bearer ${bearer}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);
    const deviceId = list.body.data[0].id as string;
    const revoke = await request(app.getHttpServer())
      .delete(`${DEVICES}/${deviceId}`)
      .set('Authorization', `Bearer ${bearer}`);
    expect(revoke.status).toBe(204);

    // 6) The SAME remember cookie no longer fast-paths: login demands the second factor again.
    const third = await request(app.getHttpServer())
      .post(LOGIN)
      .set('Cookie', `ftd_remember=${remember}`)
      .send({ email: MFA_USER.email, password: MFA_USER.password });
    expect(third.status).toBe(200);
    expect(third.body.data.status).toBe('mfa_required');
  });
});
