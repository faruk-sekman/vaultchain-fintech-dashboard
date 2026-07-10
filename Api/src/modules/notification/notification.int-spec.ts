/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Integration tests for the notification domain against a REAL ephemeral PostgreSQL 16
 * (Docker CLI). The headline is the MANDATORY recipient-scope security gate:
 *
 *   🔴 NEGATIVE SSE TEST: while user A is connected to GET /dashboard/stream, a notification emitted for
 *      user B is NOT delivered to A's stream — proven by reading A's live event bytes. A also cannot
 *      read/mark B's notification (404). This is a DoD blocker (FE filtering is NOT a security control).
 *
 * Plus the endpoint contract: paged recipient-scoped GET /operator/notifications (+ unreadCount + the
 * read/type filters), POST /{id}/read, POST /read-all (all recipient-scoped), the paramsJson guard
 * (rejected on emit), and the retention prune.
 *
 * Run with: `npm run test:int` (requires Docker). Own container + port. Excluded from the unit run.
 */
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { hash } from '@node-rs/argon2';
import { execSync } from 'node:child_process';
import { get as httpGet, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { NOTIFICATION_RETENTION_DAYS } from './notification.service';
import { STREAM_COOKIE_NAME } from '../realtime/stream-token.guard';

const CONTAINER = 'ftd-notification-test-pg';
const DATABASE_URL = 'postgresql://postgres:postgres@localhost:55441/fintech_test';
const LOGIN = '/api/v1/auth/login';
const STREAM_TOKEN = '/api/v1/dashboard/stream-token';
const STREAM = '/api/v1/dashboard/stream';
const NOTIFS = '/api/v1/operator/notifications';

const USER_A = { email: 'usera@example.com', password: 'Test-Passw0rd!' };
const USER_B = { email: 'userb@example.com', password: 'Test-Passw0rd!' };

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
let notifications: NotificationService;
let baseUrl = '';
let userAId = '';
let userBId = '';
let authA = '';
let authB = '';

async function seedUser(email: string, password: string): Promise<string> {
  const userId = uuidv7();
  const roleId = uuidv7();
  await prisma.user.create({ data: { id: userId, email: email.toLowerCase(), passwordHash: await hash(password) } });
  await prisma.role.create({ data: { id: roleId, name: `role-${userId}` } });
  await prisma.userRole.create({ data: { userId, roleId } });
  // customers.read so the operator can mint a stream-token (the SSE auth path).
  const code = 'customers.read';
  const perm = (await prisma.permission.findUnique({ where: { code } })) ?? (await prisma.permission.create({ data: { id: uuidv7(), code } }));
  await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
  return userId;
}

const login = (creds: { email: string; password: string }) =>
  request(app.getHttpServer()).post(LOGIN).send(creds);

async function mintStreamCookie(creds: { email: string; password: string }): Promise<string> {
  const accessToken = (await login(creds)).body.data.accessToken;
  const res = await request(app.getHttpServer()).post(STREAM_TOKEN).set('Authorization', `Bearer ${accessToken}`);
  const cookie = streamCookieFrom(res);
  if (!cookie) throw new Error('stream cookie was not set');
  return cookie;
}

beforeAll(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-key';
  process.env.JWT_REFRESH_SECRET = 'integration-test-secret-key';
  process.env.THROTTLE_DISABLED = '1';

  sh(`docker rm -f ${CONTAINER} || true`);
  sh(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=postgres ` +
      `-e POSTGRES_DB=fintech_test -p 55441:5432 postgres:16-alpine`,
  );
  await waitForPostgres();
  sh('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL } });

  const { AppModule } = await import('../../app.module');
  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.register(fastifyCookie);
  await app.init();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  prisma = app.get(PrismaService);
  notifications = app.get(NotificationService);
  userAId = await seedUser(USER_A.email, USER_A.password);
  userBId = await seedUser(USER_B.email, USER_B.password);
  authA = `Bearer ${(await login(USER_A)).body.data.accessToken}`;
  authB = `Bearer ${(await login(USER_B)).body.data.accessToken}`;
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  try {
    sh(`docker rm -f ${CONTAINER}`);
  } catch {
    // best-effort teardown
  }
});

/**
 * Open GET /dashboard/stream and COLLECT the `data:` payloads that arrive within `windowMs`, then tear
 * the socket down. Returns the parsed event objects the client's onmessage would have seen. Unlike the
 * realtime int-spec's handshake helper, this reads the body so we can assert on delivered events.
 */
function collectStreamEvents(cookie: string, windowMs: number, trigger: () => Promise<void>): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    // EventSource sends the credential in the httpOnly `ftd_stream` cookie — replicate that header
    // exactly (NAME=VALUE), or the StreamTokenGuard 401s and nothing connects.
    const req = httpGet(
      `${baseUrl}${STREAM}`,
      { headers: { Cookie: `${STREAM_COOKIE_NAME}=${cookie}` } },
      (res: IncomingMessage) => {
        if (res.statusCode !== 200) {
          res.destroy();
          req.destroy();
          reject(new Error(`stream did not open (status ${res.statusCode})`));
          return;
        }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          // SSE frames are separated by a blank line; each `data:` line is JSON (named `ping` ignored).
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (/^event:\s*ping/m.test(frame)) continue; // keepalive, not an onmessage event
            const m = /^data:\s*(.*)$/m.exec(frame);
            if (!m) continue;
            try {
              events.push(JSON.parse(m[1]));
            } catch {
              // non-JSON keepalive payload — ignore
            }
          }
        });
        // Headers arrived = the controller's stream() observable is subscribed (the RxJS subscription
        // is live). Give the event loop a tick, fire the trigger, then collect for the window + close.
        setTimeout(() => {
          void trigger().then(() => {
            setTimeout(() => {
              res.destroy();
              req.destroy();
              resolve(events);
            }, windowMs);
          });
        }, 100);
      },
    );
    req.on('error', (err) => {
      if (/aborted|socket hang up|ECONNRESET/i.test(String(err.message))) return;
      reject(err);
    });
  });
}

describe('Notification recipient-scope SSE gate (integration) 🔴', () => {
  it('user A connected to the stream DOES NOT receive a notification emitted for user B', async () => {
    const cookieA = await mintStreamCookie(USER_A);

    const eventsSeenByA = await collectStreamEvents(cookieA, 700, async () => {
      // Emit a notification addressed to B while A is the one listening.
      await notifications.emit({
        recipientUserId: userBId,
        type: 'SECURITY_ALERT',
        severity: 'critical',
        titleKey: 'notifications.security.test.title',
        bodyKey: 'notifications.security.test.body',
        resourceType: 'user',
        resourceId: userBId,
      });
    });

    // The security boundary: NONE of A's delivered events may be B's notification.created.
    const leaked = eventsSeenByA.filter(
      (e) => (e as { type?: string }).type === 'notification.created',
    );
    expect(leaked).toHaveLength(0);

    // And the row really exists for B (so the absence above is true scoping, not a no-op emit).
    const bCount = await prisma.notification.count({ where: { recipientUserId: userBId } });
    expect(bCount).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('user A DOES receive a notification emitted for A (positive control)', async () => {
    const cookieA = await mintStreamCookie(USER_A);

    const eventsSeenByA = await collectStreamEvents(cookieA, 700, async () => {
      await notifications.emit({
        recipientUserId: userAId,
        type: 'SYSTEM',
        severity: 'info',
        titleKey: 'notifications.system.test.title',
        bodyKey: 'notifications.system.test.body',
        resourceType: 'system',
      });
    });

    const mine = eventsSeenByA.filter((e) => (e as { type?: string }).type === 'notification.created');
    expect(mine.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe('GET/POST /operator/notifications — recipient-scoped (integration)', () => {
  it('lists ONLY the caller\'s notifications + unreadCount', async () => {
    // Seed one for A and one for B directly.
    await notifications.emit({ recipientUserId: userAId, type: 'CUSTOMER_EVENT', severity: 'info', titleKey: 't.a', bodyKey: 'b.a', resourceType: 'customer' });
    await notifications.emit({ recipientUserId: userBId, type: 'CUSTOMER_EVENT', severity: 'info', titleKey: 't.b', bodyKey: 'b.b', resourceType: 'customer' });

    const resA = await request(app.getHttpServer()).get(NOTIFS).set('Authorization', authA);
    expect(resA.status).toBe(200);
    expect(Array.isArray(resA.body.data)).toBe(true);
    // Every returned row is A's (no titleKey 't.b' from B leaks in).
    expect(resA.body.data.every((n: { titleKey: string }) => n.titleKey !== 't.b')).toBe(true);
    expect(typeof resA.body.unreadCount).toBe('number');
    expect(resA.body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('401s without a token', async () => {
    const res = await request(app.getHttpServer()).get(NOTIFS);
    expect(res.status).toBe(401);
  });

  it('A cannot mark B\'s notification read → 404 (IDOR-safe)', async () => {
    const { id } = await notifications.emit({ recipientUserId: userBId, type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'system' });
    const res = await request(app.getHttpServer()).post(`${NOTIFS}/${id}/read`).set('Authorization', authA);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('Notification.NotFound');
    // The row is still unread (A's failed attempt did not flip B's row).
    const row = await prisma.notification.findUnique({ where: { id } });
    expect(row?.readAt).toBeNull();
  });

  it('A marks A\'s own notification read → 200 + decremented unreadCount', async () => {
    const { id } = await notifications.emit({ recipientUserId: userAId, type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'system' });
    const before = (await request(app.getHttpServer()).get(NOTIFS).set('Authorization', authA)).body.unreadCount;
    const res = await request(app.getHttpServer()).post(`${NOTIFS}/${id}/read`).set('Authorization', authA);
    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBeLessThan(before);
    const row = await prisma.notification.findUnique({ where: { id } });
    expect(row?.readAt).not.toBeNull();
  });

  it('read-all marks all of A\'s unread read (B unaffected)', async () => {
    await notifications.emit({ recipientUserId: userAId, type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'system' });
    await notifications.emit({ recipientUserId: userBId, type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'system' });

    const res = await request(app.getHttpServer()).post(`${NOTIFS}/read-all`).set('Authorization', authA);
    expect(res.status).toBe(200);
    expect(res.body.data.unreadCount).toBe(0);

    const aUnread = await prisma.notification.count({ where: { recipientUserId: userAId, readAt: null } });
    const bUnread = await prisma.notification.count({ where: { recipientUserId: userBId, readAt: null } });
    expect(aUnread).toBe(0);
    expect(bUnread).toBeGreaterThanOrEqual(1); // B's unread is untouched
  });

  it('filters by read state', async () => {
    const res = await request(app.getHttpServer()).get(`${NOTIFS}?filter[read]=false`).set('Authorization', authB);
    expect(res.status).toBe(200);
    expect(res.body.data.every((n: { readAt: string | null }) => n.readAt === null)).toBe(true);
  });

  it('rejects an out-of-range page size with 400', async () => {
    const res = await request(app.getHttpServer()).get(`${NOTIFS}?page[size]=101`).set('Authorization', authA);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('Validation.Failed');
  });
});

describe('paramsJson guard + retention (integration)', () => {
  it('emit REJECTS a forbidden PII param (no row written)', async () => {
    const before = await prisma.notification.count();
    await expect(
      notifications.emit({
        recipientUserId: userAId,
        type: 'SYSTEM',
        severity: 'info',
        titleKey: 't',
        bodyKey: 'b',
        resourceType: 'system',
        params: { email: 'leak@example.com' },
      }),
    ).rejects.toThrow();
    const after = await prisma.notification.count();
    expect(after).toBe(before); // fail-closed — nothing persisted
  });

  it('retention prune deletes rows older than the window', async () => {
    // Insert an old row directly (bypassing emit, which always stamps now()).
    const oldId = uuidv7();
    const old = new Date(Date.now() - (NOTIFICATION_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000);
    await prisma.notification.create({
      data: { id: oldId, recipientUserId: userAId, type: 'SYSTEM', severity: 'info', titleKey: 't', bodyKey: 'b', resourceType: 'system', createdAt: old },
    });

    const deleted = await notifications.prune();
    expect(deleted).toBeGreaterThanOrEqual(1);
    const stillThere = await prisma.notification.findUnique({ where: { id: oldId } });
    expect(stillThere).toBeNull();
  });
});
