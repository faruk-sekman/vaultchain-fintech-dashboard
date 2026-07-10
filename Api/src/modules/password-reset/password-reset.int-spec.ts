/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the self-service password reset against a REAL ephemeral PostgreSQL 16. Two layers:
 *
 *  (A) cookie / guard / no-enumeration surface (mock can't prove this):
 *   - initiate ALWAYS 202 with a byte-identical data payload AND ALWAYS a Set-Cookie
 *     ftd_pwreset (eligible MFA, non-MFA, AND absent email) — the header never leaks MFA-enrollment;
 *     httpOnly + SameSite=Strict + scoped. An absent email is 202 (not the old SYSTEM_ACTOR-FK 409).
 *   - the factor gate — verify { newPassword } WITHOUT a prior verify-code is 401
 *     Auth.ResetFactorRequired; the clean break (a stale { code, newPassword } body → 400); the guard
 *     (no cookie → 401); the ineligible-branch DECOY cookie is unusable.
 *
 *  (B) the HAPPY factor path with a LIVE encrypted TOTP secret + real backup codes:
 *   - verify-code with a live TOTP stamps factor_verified_at on the real challenge row, then verify
 *     { newPassword } REALLY changes the password (old hash fails, new works) and consumes the challenge.
 *   - replay floor: the SAME TOTP can't verify a SECOND (fresh) challenge — a factor is single-use.
 *   - backup code: verify-code with a real backup code stamps the challenge + marks the code used; a
 *     reused backup code fails closed.
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port (no collision with other suites).
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash, verify as argonVerify } from '@node-rs/argon2';
import fastifyCookie from '@fastify/cookie';
import { generate as generateTotpToken } from 'otplib';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TotpService } from '../mfa/totp.service';
import { BackupCodeService } from '../mfa/backup-code.service';

const PWRESET_COOKIE = 'ftd_pwreset';
const CONTAINER = 'ftd-pwreset-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55436/fintech_test';
const INITIATE = '/api/v1/auth/password/reset/initiate';
const VERIFY_CODE = '/api/v1/auth/password/reset/verify-code';
const VERIFY = '/api/v1/auth/password/reset/verify';

const MFA_USER = { email: 'mfa-op@example.com', password: 'Old-Passw0rd-1!' };
const REPLAY_USER = { email: 'replay-op@example.com', password: 'Old-Passw0rd-2!' };
const BACKUP_USER = { email: 'backup-op@example.com', password: 'Old-Passw0rd-3!' };
const NON_MFA_USER = { email: 'plain-op@example.com', password: 'Old-Passw0rd-4!' };
const STRONG = 'New-Passw0rd-99!';

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

/** Pull the ftd_pwreset cookie value out of a Set-Cookie response header (or undefined). */
function pwresetCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = list.find((c) => c.startsWith(`${PWRESET_COOKIE}=`));
  if (!match) return undefined;
  const value = match.slice(`${PWRESET_COOKIE}=`.length).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

/** The challenge id embedded in a `pwr_<uuid>.<secret>` cookie value (for DB-state assertions). */
function challengeIdFromCookie(cookie: string): string {
  return cookie.slice('pwr_'.length, cookie.indexOf('.'));
}

/** A live 6-digit TOTP for `secret`, matching TotpService's period/digits/algorithm. */
function liveTotp(secret: string): Promise<string> {
  return generateTotpToken({ secret, period: 30, digits: 6, algorithm: 'sha1' });
}

let app: NestFastifyApplication;
let prisma: PrismaService;
let mfaUserId: string;
let mfaSecret: string;
let replaySecret: string;
let backupUserId: string;
let backupPlaintext: string[];

const initiate = (email: string) => request(app.getHttpServer()).post(INITIATE).send({ email });
const verifyCode = (cookie: string, code: string) =>
  request(app.getHttpServer()).post(VERIFY_CODE).set('Cookie', `${PWRESET_COOKIE}=${cookie}`).send({ code });
const verifyPassword = (cookie: string, newPassword: string) =>
  request(app.getHttpServer()).post(VERIFY).set('Cookie', `${PWRESET_COOKIE}=${cookie}`).send({ newPassword });

/** Seed an active, MFA-confirmed user with a real encrypted TOTP secret; returns id + plaintext secret. */
async function seedMfaUser(totp: TotpService, email: string, password: string): Promise<{ id: string; secret: string }> {
  const id = uuidv7();
  const secret = totp.generateSecret();
  await prisma.user.create({
    data: {
      id,
      email,
      passwordHash: await hash(password),
      mfaEnabled: true,
      mfaConfirmedAt: new Date(),
      totpSecretEnc: await totp.encryptSecret(secret, id),
      status: 'ACTIVE',
    },
  });
  return { id, secret };
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1'; // many initiate/verify calls from one test IP would hit the cap

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55436:5432 postgres:16-alpine`,
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
  const totp = app.get(TotpService);
  const backupCodes = app.get(BackupCodeService);

  // Three eligible MFA users with distinct TOTP secrets — separate users keep each test's replay floor
  // isolated (a TOTP step spent by one test never blocks another).
  ({ id: mfaUserId, secret: mfaSecret } = await seedMfaUser(totp, MFA_USER.email, MFA_USER.password));
  ({ secret: replaySecret } = await seedMfaUser(totp, REPLAY_USER.email, REPLAY_USER.password));
  ({ id: backupUserId } = await seedMfaUser(totp, BACKUP_USER.email, BACKUP_USER.password));
  backupPlaintext = await backupCodes.generate(backupUserId, 5); // real one-time codes (hashes stored)

  // Ineligible (no MFA) → initiate returns a structurally-valid DECOY cookie.
  await prisma.user.create({
    data: { id: uuidv7(), email: NON_MFA_USER.email, passwordHash: await hash(NON_MFA_USER.password), status: 'ACTIVE' },
  });
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

describe('POST initiate — no enumeration via Set-Cookie', () => {
  it('eligible MFA account: 202 + ftd_pwreset cookie (httpOnly, SameSite=Strict, scoped)', async () => {
    const res = await initiate(MFA_USER.email);
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('reset_initiated');
    expect(pwresetCookieFrom(res)).toMatch(/^pwr_/);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('non-MFA account: 202 + a ftd_pwreset cookie too (decoy) — header uniform', async () => {
    const res = await initiate(NON_MFA_USER.email);
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('reset_initiated');
    expect(pwresetCookieFrom(res)).toMatch(/^pwr_/);
  });

  it('ABSENT email: 202 + a ftd_pwreset cookie too (decoy) — presence cannot enumerate', async () => {
    const res = await initiate('ghost-nobody@example.com');
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('reset_initiated');
    expect(pwresetCookieFrom(res)).toMatch(/^pwr_/);
  });

  it('all three branches return a byte-identical data payload AND every branch sets the cookie', async () => {
    const a = await initiate(MFA_USER.email);
    const b = await initiate(NON_MFA_USER.email);
    const c = await initiate('ghost2@example.com');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(c.status).toBe(202);
    // Compare the data payload — the meta.correlationId is request-scoped + random (not account-derived).
    expect(JSON.stringify(a.body.data)).toBe(JSON.stringify(b.body.data));
    expect(JSON.stringify(b.body.data)).toBe(JSON.stringify(c.body.data));
    expect(pwresetCookieFrom(a)).toBeDefined();
    expect(pwresetCookieFrom(b)).toBeDefined();
    expect(pwresetCookieFrom(c)).toBeDefined();
  });
});

describe('guard + factor gate', () => {
  it('verify-code with NO challenge cookie -> 401 Auth.ResetChallengeMissing', async () => {
    const res = await request(app.getHttpServer()).post(VERIFY_CODE).send({ code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.ResetChallengeMissing');
  });

  it('verify with NO challenge cookie -> 401 Auth.ResetChallengeMissing', async () => {
    const res = await request(app.getHttpServer()).post(VERIFY).send({ newPassword: STRONG });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.ResetChallengeMissing');
  });

  it('verify { newPassword } BEFORE verify-code (no factor stamp) -> 401 Auth.ResetFactorRequired', async () => {
    const cookie = pwresetCookieFrom(await initiate(MFA_USER.email))!;
    const res = await verifyPassword(cookie, STRONG);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.ResetFactorRequired');
  });

  it('a stale { code, newPassword } body is rejected by forbidNonWhitelisted (clean break)', async () => {
    const cookie = pwresetCookieFrom(await initiate(MFA_USER.email))!;
    const res = await request(app.getHttpServer())
      .post(VERIFY)
      .set('Cookie', `${PWRESET_COOKIE}=${cookie}`)
      .send({ code: '123456', newPassword: STRONG });
    expect(res.status).toBe(400); // the unknown `code` field is rejected, never silently accepted
  });

  it('the ineligible-branch DECOY cookie is unusable — verify-code fails closed (AC2)', async () => {
    const decoy = pwresetCookieFrom(await initiate('ghost3@example.com'))!;
    const res = await verifyCode(decoy, '123456');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.ResetChallengeInvalid');
  });
});

describe('happy path — live TOTP + backup factor', () => {
  it('TOTP: verify-code stamps the challenge, verify REALLY changes the password (old fails, new works)', async () => {
    const cookie = pwresetCookieFrom(await initiate(MFA_USER.email))!;

    const vc = await verifyCode(cookie, await liveTotp(mfaSecret));
    expect(vc.status).toBe(200);
    expect(vc.body.data.status).toBe('code_verified');
    // factor_verified_at + method are really stamped on the challenge row.
    const stamped = await prisma.passwordResetChallenge.findUnique({ where: { id: challengeIdFromCookie(cookie) } });
    expect(stamped?.factorVerifiedAt).toBeTruthy();
    expect(stamped?.factorMethod).toBe('totp');

    const v = await verifyPassword(cookie, STRONG);
    expect(v.status).toBe(200);
    expect(v.body.data.status).toBe('reset_complete');

    // The password REALLY changed: the new password verifies, the old one no longer does.
    const user = await prisma.user.findUnique({ where: { id: mfaUserId } });
    expect(await argonVerify(user!.passwordHash, STRONG)).toBe(true);
    expect(await argonVerify(user!.passwordHash, MFA_USER.password)).toBe(false);
    // ...and the challenge is consumed (single-use).
    const consumed = await prisma.passwordResetChallenge.findUnique({ where: { id: challengeIdFromCookie(cookie) } });
    expect(consumed?.consumedAt).toBeTruthy();
  });

  it('replay floor: the SAME TOTP cannot verify a SECOND fresh challenge (factor is single-use)', async () => {
    const code = await liveTotp(replaySecret);

    const first = pwresetCookieFrom(await initiate(REPLAY_USER.email))!;
    const ok = await verifyCode(first, code);
    expect(ok.status).toBe(200); // first use advances User.lastUsedTotpStep

    const second = pwresetCookieFrom(await initiate(REPLAY_USER.email))!;
    const replay = await verifyCode(second, code); // same code, different challenge
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('Auth.ResetInvalidCode');
  });

  it('backup code: verify-code stamps the challenge + marks the code used; a reused code fails closed', async () => {
    const code = backupPlaintext[0];

    const cookie = pwresetCookieFrom(await initiate(BACKUP_USER.email))!;
    const vc = await verifyCode(cookie, code);
    expect(vc.status).toBe(200);
    expect(vc.body.data.status).toBe('code_verified');
    const stamped = await prisma.passwordResetChallenge.findUnique({ where: { id: challengeIdFromCookie(cookie) } });
    expect(stamped?.factorMethod).toBe('backup_code');
    // exactly one backup code is now consumed.
    expect(await prisma.backupCode.count({ where: { userId: backupUserId, usedAt: { not: null } } })).toBe(1);

    // Reusing the SAME backup code on a fresh challenge fails closed.
    const next = pwresetCookieFrom(await initiate(BACKUP_USER.email))!;
    const reuse = await verifyCode(next, code);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('Auth.ResetInvalidCode');
  });
});
