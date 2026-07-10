/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetRequestService (A15/A16). Every collaborator is mocked; argon2id runs for
 * real so the decoy-hash / owner-rotate / token-verify paths are exercised. Covers:
 *   create — the A16 enumeration matrix (unknown email / non-ACTIVE / duplicate-open with owner vs
 *     foreign cookie / cooldown / lost tx race → ALL the same neutral decoy outcome + ONE
 *     created:false audit), the real create (row shape, coarse ip_prefix, UA truncation, admin fan-out
 *     with MASKED params, created:true audit), owner-cookie rotation (no new row), and the lazy
 *     flips-then-creates expiry.
 *   status — fail-closed 'pending' for missing/decoy/unknown/bad-secret tokens; state mapping; lazy
 *     expiry (pending AND approved-unclaimed); the claim (pre-stamped 'admin_approval' challenge +
 *     challengeId persisted + claim audit + cookie payload), re-mint on re-poll, completed → no
 *     re-mint, non-ACTIVE user fail-closes neutrally.
 *   admin — list (lazy sweep, PENDING-first order args, filter, take 100, masked emails, decider
 *     names), detail (device metadata + lazy flip), approve/deny (happy + notification + audit,
 *     AlreadyDecided, Expired incl. lazy flip, self → 403, 404, lost decide race).
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { hash } from '@node-rs/argon2';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { NotificationService } from '../notification/notification.service';
import type { PasswordResetChallengeService } from './password-reset-challenge.service';
import { PasswordResetRequestService } from './password-reset-request.service';

const USER_ID = '0190a0b0-0000-7000-8000-0000000000aa';
const REQ_ID = '0190a0b0-0000-7000-8000-0000000000bb';
const ADMIN_ID = '0190a0b0-0000-7000-8000-0000000000cc';
const EMAIL = 'operator@example.com';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

/** A persisted request row (DB shape) — override per test. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REQ_ID,
    userId: USER_ID,
    tokenHash: 'not-a-real-hash',
    status: 'PENDING',
    ipHash: null,
    ipPrefix: '203.0.113.0/24',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0 Safari/537.36',
    expiresAt: FUTURE,
    decidedBy: null,
    decidedAt: null,
    challengeId: null,
    completedAt: null,
    createdAt: new Date('2026-07-01T10:00:00Z'),
    user: { displayName: 'Op Erator', email: EMAIL },
    ...overrides,
  };
}

function setup() {
  const tx = {
    passwordResetRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    passwordResetRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (cb: (c: typeof tx) => Promise<boolean>) => cb(tx)),
  };
  const challenges = {
    create: jest.fn().mockResolvedValue({ token: 'pwr_ch.secret', challengeId: 'ch-1', expiresAt: new Date() }),
    markFactorVerified: jest.fn().mockResolvedValue(true),
  };
  const config = { get: jest.fn((_key: string): number | undefined => undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    emitToPermissionHolders: jest.fn().mockResolvedValue(1),
    emit: jest.fn().mockResolvedValue({ id: 'n1', deduped: false }),
  };
  const svc = new PasswordResetRequestService(
    prisma as unknown as PrismaService,
    challenges as unknown as PasswordResetChallengeService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    notifications as unknown as NotificationService,
  );
  return { svc, prisma, tx, challenges, config, audit, notifications };
}

/** Assert a neutral decoy create outcome: pwq_ token, ONE created:false audit, NO row written. */
function expectDecoy(
  m: ReturnType<typeof setup>,
  res: { requestToken: string; requestTtlSeconds: number },
  actorUserId: string | null,
) {
  expect(res.requestToken).toMatch(/^pwq_/);
  expect(m.tx.passwordResetRequest.create).not.toHaveBeenCalled();
  expect(m.notifications.emitToPermissionHolders).not.toHaveBeenCalled();
  expect(m.audit.record).toHaveBeenCalledTimes(1);
  expect(m.audit.record).toHaveBeenCalledWith(
    expect.objectContaining({
      actorUserId,
      action: 'password.reset_request.create',
      resourceType: 'auth.password_reset_request',
      outcome: 'SUCCESS',
      context: expect.objectContaining({ created: false }),
    }),
  );
  const ctx = m.audit.record.mock.calls[0][0].context as { email: string };
  expect(ctx.email).not.toBe(EMAIL);
  expect(ctx.email).toContain('***');
}

describe('PasswordResetRequestService.create (A16 enumeration matrix)', () => {
  it('#C1 unknown email: NO row, decoy token, ONE created:false audit with actor null', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue(null);
    const res = await m.svc.create('ghost@example.com', null, { ip: '1.2.3.4' });
    expect(res.requestTtlSeconds).toBe(86_400); // in-code default
    expect(res.requestToken).toMatch(/^pwq_/);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: null, context: expect.objectContaining({ created: false }) }),
    );
    expect(m.notifications.emitToPermissionHolders).not.toHaveBeenCalled();
  });

  it('#C2 non-ACTIVE account: same neutral decoy outcome (actor recorded, nothing created)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'SUSPENDED' });
    const res = await m.svc.create(EMAIL, null, {});
    expectDecoy(m, res, USER_ID);
  });

  it('#C3 ACTIVE account (MFA state IRRELEVANT — the lookup selects only id+status): creates the row', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    const res = await m.svc.create(EMAIL, null, {
      ip: '203.0.113.7',
      userAgent: 'UA '.repeat(200), // 600 chars — must be truncated
    });

    // A no-MFA and an MFA'd account are indistinguishable to create(): only id + status are read.
    expect(m.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: EMAIL },
      select: { id: true, status: true },
    });

    // The row: coarse prefix (no raw IP), sha256 ip hash, UA capped at 400, TTL-derived expiry.
    const data = m.tx.passwordResetRequest.create.mock.calls[0][0].data as Record<string, unknown> & {
      userAgent: string;
      ipHash: string;
      id: string;
    };
    expect(data.userId).toBe(USER_ID);
    expect(data.ipPrefix).toBe('203.0.113.0/24');
    expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.ipHash).not.toContain('203.0.113.7');
    expect(data.userAgent.length).toBe(400);
    expect(data.tokenHash).toMatch(/^\$argon2/);
    // The returned handle references the created row (same id), secret part non-empty.
    expect(res.requestToken.startsWith(`pwq_${data.id}.`)).toBe(true);
    expect(res.requestToken.length).toBeGreaterThan(`pwq_${data.id}.`.length);

    // created:true audit with the request id + masked email.
    expect(m.audit.record).toHaveBeenCalledTimes(1);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        action: 'password.reset_request.create',
        resourceId: data.id,
        context: { email: 'o***@e***.com', created: true },
      }),
    );

    // Lazy flips-then-creates: the user's over-age open rows were swept BEFORE the duplicate checks.
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID, expiresAt: { lte: expect.any(Date) } }),
        data: { status: 'EXPIRED' },
      }),
    );
  });

  it('#C4 admin fan-out fires ONCE with MASKED account param, request-scoped resource + dedupeKey', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    await m.svc.create(EMAIL, null, {});
    const requestId = (m.tx.passwordResetRequest.create.mock.calls[0][0].data as { id: string }).id;
    expect(m.notifications.emitToPermissionHolders).toHaveBeenCalledTimes(1);
    expect(m.notifications.emitToPermissionHolders).toHaveBeenCalledWith('auth.password.admin_reset', {
      type: 'SECURITY_ALERT',
      severity: 'warning',
      titleKey: 'notifications.security.resetRequestCreated.title',
      bodyKey: 'notifications.security.resetRequestCreated.body',
      params: { account: 'o***@e***.com' }, // NEVER the raw email
      resourceType: 'password_reset_request',
      resourceId: requestId,
      dedupeKey: requestId,
    });
  });

  it('#C5 fan-out failure is swallowed (best-effort): the create still succeeds with a real token', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.notifications.emitToPermissionHolders.mockRejectedValue(new Error('sse down'));
    const res = await m.svc.create(EMAIL, null, {});
    expect(res.requestToken).toMatch(/^pwq_/);
    expect(m.tx.passwordResetRequest.create).toHaveBeenCalledTimes(1);
  });

  it('#C6 duplicate-open with the OWNER cookie: rotates the token (no new row, created:false audit)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    const ownerSecret = 'owner-held-secret';
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue(
      row({ tokenHash: await hash(ownerSecret) }),
    );

    const res = await m.svc.create(EMAIL, `pwq_${REQ_ID}.${ownerSecret}`, {});

    // The SAME request id rides in the fresh token — with a NEW secret hashed into the row.
    expect(res.requestToken).toMatch(new RegExp(`^pwq_${REQ_ID}\\.`));
    expect(res.requestToken).not.toBe(`pwq_${REQ_ID}.${ownerSecret}`);
    expect(m.prisma.passwordResetRequest.update).toHaveBeenCalledWith({
      where: { id: REQ_ID },
      data: { tokenHash: expect.stringMatching(/^\$argon2/) },
    });
    expect(m.prisma.$transaction).not.toHaveBeenCalled(); // no create attempted
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: REQ_ID, context: expect.objectContaining({ created: false }) }),
    );
    expect(m.notifications.emitToPermissionHolders).not.toHaveBeenCalled();
  });

  it('#C7 duplicate-open with NO cookie: neutral decoy (no rotate, no new row)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue(row({ tokenHash: await hash('x') }));
    const res = await m.svc.create(EMAIL, null, {});
    expectDecoy(m, res, USER_ID);
    expect(m.prisma.passwordResetRequest.update).not.toHaveBeenCalled();
  });

  it('#C8 duplicate-open with a FOREIGN cookie (wrong secret): decoy, the row is untouched', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue(row({ tokenHash: await hash('real-secret') }));
    const res = await m.svc.create(EMAIL, `pwq_${REQ_ID}.stolen-guess`, {});
    expectDecoy(m, res, USER_ID);
    expect(m.prisma.passwordResetRequest.update).not.toHaveBeenCalled();
  });

  it('#C9 cooldown: a recent row of ANY status silently absorbs the call (decoy, no new row)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.prisma.passwordResetRequest.findFirst
      .mockResolvedValueOnce(null) // no open PENDING
      .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 30 * 1000) }); // newest row 30 s old (DENIED etc.)
    const res = await m.svc.create(EMAIL, null, {});
    expectDecoy(m, res, USER_ID);
  });

  it('#C10 outside the cooldown window the create proceeds', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.prisma.passwordResetRequest.findFirst
      .mockResolvedValueOnce(null) // no open PENDING
      .mockResolvedValueOnce({ createdAt: new Date(Date.now() - 601 * 1000) }); // older than the 600 s default
    await m.svc.create(EMAIL, null, {});
    expect(m.tx.passwordResetRequest.create).toHaveBeenCalledTimes(1);
  });

  it('#C11 lost one-open-request tx race: same neutral outcome as a duplicate (decoy, created:false)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.tx.passwordResetRequest.findFirst.mockResolvedValue({ id: 'concurrent-winner' }); // in-tx re-check hits
    const res = await m.svc.create(EMAIL, null, {});
    expect(res.requestToken).toMatch(/^pwq_/);
    expect(m.tx.passwordResetRequest.create).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ created: false }) }),
    );
  });

  it('#C12 config overrides: PWRESET_REQUEST_TTL drives the returned TTL + row expiry; cooldown honors its env', async () => {
    const m = setup();
    m.config.get.mockImplementation((key: string) => (key === 'PWRESET_REQUEST_TTL' ? 120 : undefined));
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    const before = Date.now();
    const res = await m.svc.create(EMAIL, null, {});
    expect(res.requestTtlSeconds).toBe(120);
    const expiresAt = (m.tx.passwordResetRequest.create.mock.calls[0][0].data as { expiresAt: Date }).expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 119 * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 121 * 1000);
  });

  it('#C13 cooldown 0 disables the window (a fresh non-open row does not block)', async () => {
    const m = setup();
    m.config.get.mockImplementation((key: string) => (key === 'PWRESET_REQUEST_COOLDOWN' ? 0 : undefined));
    m.prisma.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' });
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue(null);
    await m.svc.create(EMAIL, null, {});
    expect(m.tx.passwordResetRequest.create).toHaveBeenCalledTimes(1);
    // Only the open-PENDING lookup ran — the newest-row cooldown query is skipped entirely at 0.
    expect(m.prisma.passwordResetRequest.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('PasswordResetRequestService.status (fail-closed poll + claim)', () => {
  /** Wire a real-token row: the presented secret argon-verifies against the stored hash. */
  async function withRow(m: ReturnType<typeof setup>, overrides: Partial<Record<string, unknown>> = {}) {
    const secret = 'status-secret';
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ tokenHash: await hash(secret), ...overrides }));
    return `pwq_${REQ_ID}.${secret}`;
  }

  it("#S1 missing token → 'pending' (no lookup at all)", async () => {
    const m = setup();
    expect(await m.svc.status(null, {})).toEqual({ status: 'pending' });
    expect(m.prisma.passwordResetRequest.findUnique).not.toHaveBeenCalled();
  });

  it("#S2 malformed / decoy / unknown / wrong-secret tokens ALL read 'pending' (indistinguishable)", async () => {
    const m = setup();
    expect(await m.svc.status('garbage', {})).toEqual({ status: 'pending' });
    expect(await m.svc.status('pwq_not-a-uuid.secret', {})).toEqual({ status: 'pending' });
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(null); // decoy/unknown id
    expect(await m.svc.status(`pwq_${REQ_ID}.whatever`, {})).toEqual({ status: 'pending' });
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ tokenHash: await hash('real') }));
    expect(await m.svc.status(`pwq_${REQ_ID}.wrong`, {})).toEqual({ status: 'pending' });
    expect(m.challenges.create).not.toHaveBeenCalled();
  });

  it("#S3 real PENDING row → 'pending'; DENIED → 'denied'; EXPIRED → 'expired' (no side effects)", async () => {
    const m = setup();
    let token = await withRow(m, { status: 'PENDING' });
    expect(await m.svc.status(token, {})).toEqual({ status: 'pending' });
    token = await withRow(m, { status: 'DENIED', decidedAt: new Date() });
    expect(await m.svc.status(token, {})).toEqual({ status: 'denied' });
    token = await withRow(m, { status: 'EXPIRED' });
    expect(await m.svc.status(token, {})).toEqual({ status: 'expired' });
    expect(m.challenges.create).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it("#S4 lazy expiry: an over-age PENDING row flips to EXPIRED and reads 'expired'", async () => {
    const m = setup();
    const token = await withRow(m, { status: 'PENDING', expiresAt: PAST });
    expect(await m.svc.status(token, {})).toEqual({ status: 'expired' });
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQ_ID, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  });

  it("#S5 lazy expiry covers the approved-UNCLAIMED window too (single TTL)", async () => {
    const m = setup();
    const token = await withRow(m, { status: 'APPROVED', expiresAt: PAST, completedAt: null });
    expect(await m.svc.status(token, {})).toEqual({ status: 'expired' });
    expect(m.challenges.create).not.toHaveBeenCalled();
  });

  it('#S6 APPROVED unclaimed + ACTIVE user: CLAIMS — mints a pre-stamped challenge bound to THIS call, persists challengeId, audits, returns the cookie payload', async () => {
    const m = setup();
    const token = await withRow(m, { status: 'APPROVED', decidedBy: ADMIN_ID, decidedAt: new Date() });
    m.prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });

    const res = await m.svc.status(token, { ip: '198.51.100.9', userAgent: 'poll-ua' });

    expect(res).toEqual({ status: 'approved', challengeToken: 'pwr_ch.secret', challengeTtlSeconds: 300 });
    // The challenge is bound to the CLAIMING call's fingerprint, standard purpose/TTL/attempts.
    expect(m.challenges.create).toHaveBeenCalledWith({
      userId: USER_ID,
      purpose: 'PASSWORD_RESET',
      ttlSeconds: 300,
      maxAttempts: 5,
      ip: '198.51.100.9',
      userAgent: 'poll-ua',
    });
    // Pre-stamped 'admin_approval' — the admin identity check IS the factor on this path.
    expect(m.challenges.markFactorVerified).toHaveBeenCalledWith('ch-1', 'admin_approval');
    // Latest-wins linkage for the completion hook.
    expect(m.prisma.passwordResetRequest.update).toHaveBeenCalledWith({
      where: { id: REQ_ID },
      data: { challengeId: 'ch-1' },
    });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        action: 'password.reset_request.claim',
        resourceType: 'auth.password_reset_request',
        resourceId: REQ_ID,
        outcome: 'SUCCESS',
        context: {},
      }),
    );
  });

  it('#S7 re-polling while approved re-mints a FRESH challenge (latest wins)', async () => {
    const m = setup();
    const token = await withRow(m, { status: 'APPROVED', challengeId: 'ch-old' });
    m.prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    await m.svc.status(token, {});
    await m.svc.status(token, {});
    expect(m.challenges.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.passwordResetRequest.update).toHaveBeenCalledTimes(2);
  });

  it("#S8 APPROVED + completedAt: terminal 'approved' with NO cookie and NO re-mint", async () => {
    const m = setup();
    const token = await withRow(m, { status: 'APPROVED', completedAt: new Date(), expiresAt: PAST });
    const res = await m.svc.status(token, {});
    expect(res).toEqual({ status: 'approved' });
    expect(m.challenges.create).not.toHaveBeenCalled();
    // A completed row is NOT "open" — the past expiry must not flip it.
    expect(m.prisma.passwordResetRequest.updateMany).not.toHaveBeenCalled();
  });

  it("#S9 APPROVED but the user is no longer ACTIVE (or gone): fail-closed neutral 'pending'", async () => {
    const m = setup();
    let token = await withRow(m, { status: 'APPROVED' });
    m.prisma.user.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    expect(await m.svc.status(token, {})).toEqual({ status: 'pending' });
    token = await withRow(m, { status: 'APPROVED' });
    m.prisma.user.findUnique.mockResolvedValue(null);
    expect(await m.svc.status(token, {})).toEqual({ status: 'pending' });
    expect(m.challenges.create).not.toHaveBeenCalled();
  });

  it("#S10 a lost factor pre-stamp fail-closes to 'pending' (never hands out an unusable cookie)", async () => {
    const m = setup();
    const token = await withRow(m, { status: 'APPROVED' });
    m.prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    m.challenges.markFactorVerified.mockResolvedValue(false);
    expect(await m.svc.status(token, {})).toEqual({ status: 'pending' });
    expect(m.prisma.passwordResetRequest.update).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });
});

describe('PasswordResetRequestService.list / detail (admin read surface)', () => {
  it('#L1 list: lazy sweep first, then PENDING-first order, optional filter off, take 100, masked emails', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findMany.mockResolvedValue([row({ decidedBy: ADMIN_ID })]);
    m.prisma.user.findMany.mockResolvedValue([{ id: ADMIN_ID, displayName: 'Admin A', email: 'admin@example.com' }]);

    const items = await m.svc.list();

    // The sweep flips over-age open rows globally BEFORE the read.
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
    expect(m.prisma.passwordResetRequest.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      include: { user: { select: { displayName: true, email: true } } },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: REQ_ID,
      account: { displayName: 'Op Erator', emailMasked: 'o***@e***.com' },
      status: 'PENDING',
      decidedByName: 'Admin A',
    });
    expect(JSON.stringify(items)).not.toContain(EMAIL); // raw email NEVER leaves the service
    expect(JSON.stringify(items)).not.toContain('tokenHash');
  });

  it('#L2 list: the ?status= filter is threaded into WHERE; a null decider maps to null name', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findMany.mockResolvedValue([row()]);
    const items = await m.svc.list('DENIED');
    expect(m.prisma.passwordResetRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'DENIED' } }),
    );
    expect(items[0].decidedByName).toBeNull();
    expect(m.prisma.user.findMany).not.toHaveBeenCalled(); // nothing to resolve
  });

  it('#L3 list: a decider without displayName falls back to their MASKED email', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findMany.mockResolvedValue([row({ decidedBy: ADMIN_ID })]);
    m.prisma.user.findMany.mockResolvedValue([{ id: ADMIN_ID, displayName: null, email: 'admin@example.com' }]);
    const items = await m.svc.list();
    expect(items[0].decidedByName).toBe('a***@e***.com');
  });

  it('#L4 detail: item + device metadata (coarse prefix, parsed summary, raw UA); 404 when unknown', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row());
    const detail = await m.svc.detail(REQ_ID);
    expect(detail).toMatchObject({
      id: REQ_ID,
      ipPrefix: '203.0.113.0/24',
      deviceSummary: 'Chrome on macOS',
      userAgent: expect.stringContaining('Mozilla/5.0'),
    });

    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(null);
    await expect(m.svc.detail(REQ_ID)).rejects.toMatchObject({ response: { code: 'Auth.ResetRequestNotFound' } });
    await expect(m.svc.detail(REQ_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('#L5 detail: an over-age open row is lazily flipped and reported EXPIRED', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ status: 'PENDING', expiresAt: PAST }));
    const detail = await m.svc.detail(REQ_ID);
    expect(detail.status).toBe('EXPIRED');
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQ_ID, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
  });
});

describe('PasswordResetRequestService.decide (approve / deny)', () => {
  function withPending(m: ReturnType<typeof setup>, overrides: Partial<Record<string, unknown>> = {}) {
    m.prisma.passwordResetRequest.findUnique
      .mockResolvedValueOnce(row(overrides)) // the decide() load
      .mockResolvedValue(row({ ...overrides, status: 'APPROVED', decidedBy: ADMIN_ID, decidedAt: new Date() })); // the refreshed detail
  }

  it('#D1 approve happy path: single-winner update, audit with target, SUCCESS notification to the requester, refreshed detail', async () => {
    const m = setup();
    withPending(m);
    m.prisma.user.findMany.mockResolvedValue([{ id: ADMIN_ID, displayName: 'Admin A', email: 'admin@example.com' }]);

    const detail = await m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED');

    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQ_ID, status: 'PENDING' },
      data: { status: 'APPROVED', decidedBy: ADMIN_ID, decidedAt: expect.any(Date) },
    });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ADMIN_ID,
        action: 'password.reset_request.approve',
        resourceType: 'auth.password_reset_request',
        resourceId: REQ_ID,
        outcome: 'SUCCESS',
        context: { targetUserId: USER_ID },
      }),
    );
    expect(m.notifications.emit).toHaveBeenCalledWith({
      recipientUserId: USER_ID,
      type: 'SECURITY_ALERT',
      severity: 'success',
      titleKey: 'notifications.security.resetRequestApproved.title',
      bodyKey: 'notifications.security.resetRequestApproved.body',
      params: {},
      resourceType: 'user',
      resourceId: USER_ID,
    });
    expect(detail.status).toBe('APPROVED');
    expect(detail.decidedByName).toBe('Admin A');
  });

  it('#D2 deny mirrors the contract with the warning-severity denial receipt', async () => {
    const m = setup();
    withPending(m);
    await m.svc.decide(ADMIN_ID, REQ_ID, 'DENIED');
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DENIED' }) }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password.reset_request.deny' }),
    );
    expect(m.notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warning',
        titleKey: 'notifications.security.resetRequestDenied.title',
      }),
    );
  });

  it('#D3 unknown id → 404 Auth.ResetRequestNotFound (nothing updated)', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(null);
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestNotFound' },
    });
    expect(m.prisma.passwordResetRequest.updateMany).not.toHaveBeenCalled();
  });

  it("#D4 an admin deciding their OWN account's request → 403 Auth.SelfResetForbidden (before any state check)", async () => {
    const m = setup();
    // status DENIED on purpose: the self guard must fire BEFORE the already-decided check.
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ userId: ADMIN_ID, status: 'DENIED' }));
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toMatchObject({
      response: { code: 'Auth.SelfResetForbidden' },
    });
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.prisma.passwordResetRequest.updateMany).not.toHaveBeenCalled();
  });

  it('#D5 already decided (APPROVED or DENIED) → 409 Auth.ResetRequestAlreadyDecided', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ status: 'APPROVED' }));
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'DENIED')).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestAlreadyDecided' },
    });
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ status: 'DENIED' }));
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toBeInstanceOf(ConflictException);
    expect(m.notifications.emit).not.toHaveBeenCalled();
  });

  it('#D6 EXPIRED status → 409 Auth.ResetRequestExpired', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ status: 'EXPIRED' }));
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestExpired' },
    });
  });

  it('#D7 over-age PENDING: lazily flipped to EXPIRED, then 409 Auth.ResetRequestExpired', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row({ status: 'PENDING', expiresAt: PAST }));
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestExpired' },
    });
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQ_ID, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it('#D8 lost decide race (0 rows updated) → 409 Auth.ResetRequestAlreadyDecided, no audit/notification', async () => {
    const m = setup();
    m.prisma.passwordResetRequest.findUnique.mockResolvedValue(row());
    m.prisma.passwordResetRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED')).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestAlreadyDecided' },
    });
    expect(m.audit.record).not.toHaveBeenCalled();
    expect(m.notifications.emit).not.toHaveBeenCalled();
  });

  it('#D9 a thrown requester notification does NOT fail the committed decision (best-effort)', async () => {
    const m = setup();
    withPending(m);
    m.notifications.emit.mockRejectedValue(new Error('sse down'));
    const detail = await m.svc.decide(ADMIN_ID, REQ_ID, 'APPROVED');
    expect(detail.status).toBe('APPROVED');
    expect(m.audit.record).toHaveBeenCalledTimes(1); // the decision audit already landed
  });
});
