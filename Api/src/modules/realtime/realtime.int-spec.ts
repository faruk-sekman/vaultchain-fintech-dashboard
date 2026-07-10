/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the dashboard SSE auth transport against a
 * REAL ephemeral PostgreSQL 16 (Docker CLI). Proves the token-in-URL fix:
 *   - POST /dashboard/stream-token sets a short-lived httpOnly cookie (`ftd_stream`) and returns 204
 *     with NO body (the credential is never exposed to JS),
 *   - the minted credential is MINIMALLY SCOPED: it decodes with scope `stream:read`, carries NO
 *     permission set, and expires in ≤60s,
 *   - GET /dashboard/stream is fail-closed: 401 with no cookie, 401 with a wrong-scope/forged cookie,
 *     and 200 `text/event-stream` WITH the cookie (and no token anywhere in the URL).
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port (no collision with the other
 * int suites). Excluded from the default unit run by the `.int-spec.ts` suffix.
 */
import { ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { hash } from '@node-rs/argon2';
import fastifyCookie from '@fastify/cookie';
import { execSync } from 'node:child_process';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { STREAM_COOKIE_NAME, STREAM_TOKEN_SCOPE } from './stream-token.guard';

const CONTAINER = 'ftd-realtime-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55438/fintech_test';
const LOGIN = '/api/v1/auth/login';
const STREAM_TOKEN = '/api/v1/dashboard/stream-token';
const STREAM = '/api/v1/dashboard/stream';

const OPERATOR = { email: 'operator@example.com', password: 'Test-Passw0rd!' };
const LIMITED = { email: 'limited@example.com', password: 'Test-Passw0rd!' }; // lacks customers.read

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

/** Pull the `ftd_stream` cookie value out of a Set-Cookie response header. */
function streamCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = list.find((c) => c.startsWith(`${STREAM_COOKIE_NAME}=`));
  if (!match) return undefined;
  const value = match.slice(`${STREAM_COOKIE_NAME}=`.length).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

let app: NestFastifyApplication;
let prisma: PrismaService;
let jwt: JwtService;
/** Base URL once the app is listening on an ephemeral port (used for the raw SSE handshake). */
let baseUrl = '';

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

const login = (email: string, password: string) =>
  request(app.getHttpServer()).post(LOGIN).send({ email, password });

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
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.register(fastifyCookie); // the stream credential rides in the httpOnly ftd_stream cookie
  await app.init();
  // Listen on an ephemeral port so the raw-http SSE handshake test has a real address to dial.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  prisma = app.get(PrismaService);
  jwt = app.get(JwtService);
  await seedUser(OPERATOR.email, OPERATOR.password, ['customers.read', 'transactions.create']);
  await seedUser(LIMITED.email, LIMITED.password, ['transactions.read']); // deliberately NOT customers.read
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

/** Mint a stream cookie for an operator (the normal client path). */
async function mintStreamCookie(): Promise<{ res: request.Response; cookie: string }> {
  const accessToken = (await login(OPERATOR.email, OPERATOR.password)).body.data.accessToken;
  const res = await request(app.getHttpServer()).post(STREAM_TOKEN).set('Authorization', `Bearer ${accessToken}`);
  const cookie = streamCookieFrom(res);
  if (!cookie) throw new Error('stream cookie was not set');
  return { res, cookie };
}

describe('POST /dashboard/stream-token (integration)', () => {
  it('requires a Bearer token (401 unauthenticated)', async () => {
    const res = await request(app.getHttpServer()).post(STREAM_TOKEN);
    expect(res.status).toBe(401);
  });

  it('403s an authenticated operator that lacks customers.read', async () => {
    const token = (await login(LIMITED.email, LIMITED.password)).body.data.accessToken;
    const res = await request(app.getHttpServer()).post(STREAM_TOKEN).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('Auth.Forbidden');
  });

  it('sets a short-lived httpOnly ftd_stream cookie and returns 204 with NO body', async () => {
    const { res, cookie } = await mintStreamCookie();
    expect(res.status).toBe(204);
    expect(res.body).toEqual({}); // 204 — credential is never in the body (not exposed to JS)
    expect(cookie).toBeTruthy();

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/dashboard/i);
    // dev/local (NODE_ENV !== production): Secure MUST be off or the cookie would never store on http.
    expect(setCookie).not.toMatch(/Secure/i);
    // bounded lifetime — the cookie maxAge mirrors the ≤60s token TTL.
    const maxAge = /Max-Age=(\d+)/i.exec(setCookie);
    expect(maxAge).not.toBeNull();
    expect(Number(maxAge![1])).toBeLessThanOrEqual(60);
  });

  it('mints a MINIMALLY-SCOPED credential: scope stream:read, NO permission set, exp ≤60s', async () => {
    const { cookie } = await mintStreamCookie();
    const payload = jwt.verify<{ sub: string; scope?: string; permissions?: unknown; exp: number; iat: number }>(cookie);
    expect(payload.scope).toBe(STREAM_TOKEN_SCOPE);
    expect(payload.scope).toBe('stream:read');
    // The credential must NOT carry the operator's permission set (the whole point of "minimal scope").
    expect(payload.permissions).toBeUndefined();
    // Short TTL: exp within 60s of iat.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(60);
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
  });
});

describe('GET /dashboard/stream — cookie auth, fail-closed (integration)', () => {
  it('401s with NO cookie', async () => {
    const res = await request(app.getHttpServer()).get(STREAM);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.StreamTokenMissing');
  });

  it('401s a forged / wrong-scope cookie', async () => {
    // A normal access-token-shaped JWT (no stream:read scope) must be rejected by the stream guard.
    const wrongScope = await jwt.signAsync({ sub: 'u1', permissions: ['customers.read'] }, { expiresIn: '60s' });
    const res = await request(app.getHttpServer()).get(STREAM).set('Cookie', `${STREAM_COOKIE_NAME}=${wrongScope}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.StreamTokenInvalid');
  });

  it('401s a garbage cookie value', async () => {
    const res = await request(app.getHttpServer()).get(STREAM).set('Cookie', `${STREAM_COOKIE_NAME}=not-a-jwt`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('Auth.StreamTokenInvalid');
  });

  it('opens the text/event-stream WITH the cookie (handshake 200 + content-type)', async () => {
    const { cookie } = await mintStreamCookie();
    // @Sse is an infinite stream; capture the handshake (status + content-type) then destroy the
    // socket so the test doesn't hang on the open connection.
    const { status, contentType } = await openSseHandshake(`${STREAM_COOKIE_NAME}=${cookie}`);
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/event-stream/);
  });
});

/**
 * Open GET /dashboard/stream over a raw http request and resolve as soon as the response headers
 * arrive, then destroy the socket (the SSE body never ends). Raw http (not supertest) is used so the
 * socket teardown of an open stream is fully under our control and emits no unhandled abort error.
 */
function openSseHandshake(cookie: string): Promise<{ status: number; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(`${baseUrl}${STREAM}`, { headers: { Cookie: cookie } }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      res.destroy(); // tear down the never-ending stream once headers are captured
      req.destroy();
      resolve({ status, contentType });
    });
    req.on('error', (err) => {
      // A destroy after we've read headers can surface a benign socket error; ignore it.
      if (/aborted|socket hang up|ECONNRESET/i.test(String(err.message))) return;
      reject(err);
    });
  });
}
