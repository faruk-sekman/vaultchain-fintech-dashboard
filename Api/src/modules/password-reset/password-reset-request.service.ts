/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Admin-approval password-reset requests (A15 + the A16 abuse guards; bugfix-backlog-2026-07). The
 * fallback for an operator who CANNOT self-serve the MFA-gated reset (no authenticator): the user asks,
 * every `auth.password.admin_reset` holder is notified, an admin approves/denies after an out-of-band
 * identity check, and the forgot-password screen — polling the status endpoint — receives a standard
 * `ftd_pwreset` challenge PRE-STAMPED `factor_method='admin_approval'`, so the EXISTING
 * POST /auth/password/reset/verify endpoint completes the reset unchanged. No email, no admin-chosen
 * password (the admin never holds the credential).
 *
 * The requesting BROWSER is bound to its request by the opaque `pwq_<id>.<secret>` token in the
 * httpOnly, SameSite=Strict `ftd_pwreq` cookie — an exact clone of the challenge-token pattern (only
 * the argon2id hash of the secret is stored). The cookie is the ONLY handle: owner-only truth flows
 * exclusively through status(); create() answers EVERY caller with the same 202 + a Set-Cookie.
 *
 * A16 enumeration/abuse posture on create(): ONE open (PENDING) request per account (transactional
 * re-check — authoritative; a partial unique index in prisma/sql/integrity.sql is the prod backstop),
 * a per-account cooldown over the newest row of ANY status, and byte-identical neutral responses on
 * every branch — unknown email, non-ACTIVE user, duplicate, cooldown, and lost race all return a fresh
 * DECOY cookie after the SAME argon2id work as the real branch (timing-equalized, mirroring initiate()).
 * An owner re-presenting their real cookie gets their request's token ROTATED (re-entry keeps working)
 * without creating a row.
 *
 * Expiry is LAZY (no scheduler): ONE TTL covers both the pending-decision and the approved-unclaimed
 * windows, and every reader — create, status, admin list/detail, approve/deny — flips an over-age open
 * row (PENDING, or APPROVED never completed) to EXPIRED when it touches it.
 *
 * Tokens/secrets/raw emails/raw IPs never reach logs, notifications, or the audit context — masked
 * email + sha256(ip) + a coarse ip_prefix only. The raw UA is stored (service-truncated to 400 chars)
 * for the admin detail panel; the coarse summary is computed at read time (user-agent.ts).
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { PasswordResetRequestStatus, type Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { maskEmail } from '../../common/util/mask';
import { summarizeUserAgent } from '../../common/util/user-agent';
import { isUuid, uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  ResetRequestDetailDto,
  ResetRequestItemDto,
  ResetRequestPollStatus,
} from './dto/reset-request.dto';
import {
  PWRESET_CHALLENGE_TTL_DEFAULT,
  PWRESET_MAX_ATTEMPTS_DEFAULT,
  PWRESET_REQUEST_COOLDOWN_DEFAULT,
  PWRESET_REQUEST_TOKEN_PREFIX,
  PWRESET_REQUEST_TTL_DEFAULT,
  PasswordResetPurpose,
} from './password-reset.constants';
import type { ResetContext } from './password-reset.service';
import { PasswordResetChallengeService } from './password-reset-challenge.service';

/** The permission that gates the admin surface AND selects the fan-out recipients (reuse). */
export const ADMIN_RESET_PERMISSION = 'auth.password.admin_reset';

/** Max rows the v1 admin list returns (no pagination — requests are rare and short-lived). */
const ADMIN_LIST_TAKE = 100;

/** Stored raw-UA cap — enough for any real browser UA, bounds a hostile header. */
const USER_AGENT_MAX_LENGTH = 400;

/** What the controller needs to finish the create response: the cookie value + its TTL. ALWAYS present
 *  (real or decoy) so the Set-Cookie header is uniform across every branch. */
export interface CreateResetRequestResult {
  requestToken: string;
  requestTtlSeconds: number;
}

/** Status/claim outcome. The challenge token is present ONLY on a freshly-claimed approval. */
export interface ResetRequestStatusResult {
  status: ResetRequestPollStatus;
  /** A standard `pwr_…` reset-challenge token pre-stamped 'admin_approval' — set as ftd_pwreset. */
  challengeToken?: string;
  challengeTtlSeconds?: number;
}

/** A precomputed, clearly-labeled decoy argon2id input equalizing timing on the no-row branches. */
const DECOY_REQUEST = 'ftd-password-reset-request-decoy-not-a-secret';

type RequestWithUser = Prisma.PasswordResetRequestGetPayload<{
  include: { user: { select: { displayName: true; email: true } } };
}>;

@Injectable()
export class PasswordResetRequestService {
  private readonly logger = new Logger(PasswordResetRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challenges: PasswordResetChallengeService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * File (or neutrally absorb) a reset request. EVERY branch returns the same shape — a token for the
   * `ftd_pwreq` cookie + its TTL — and writes exactly ONE `password.reset_request.create` audit row
   * (masked email + created flag). A real row is created only for an ACTIVE account with no open
   * request and outside the cooldown; every other branch runs the same argon2id work and hands back a
   * structurally-valid DECOY token that references no row (fail-closed in status()).
   */
  async create(email: string, presentedToken: string | null, ctx: ResetContext): Promise<CreateResetRequestResult> {
    const ttlSeconds = this.config.get<number>('PWRESET_REQUEST_TTL') ?? PWRESET_REQUEST_TTL_DEFAULT;
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });

    // Unknown email / non-ACTIVE account → no row, decoy handle (user_id is NOT nullable by design).
    if (!user || user.status !== 'ACTIVE') {
      return this.decoyOutcome(email, user?.id ?? null, ttlSeconds, ctx);
    }

    // Lazy expiry FIRST — an over-age open row must not block a fresh request (create flips-then-creates).
    await this.expireOverdue(user.id);

    const open = await this.prisma.passwordResetRequest.findFirst({
      where: { userId: user.id, status: PasswordResetRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      // Owner re-entry: the presented ftd_pwreq verifies against the open row → ROTATE its secret so
      // the owner's handle keeps working (fresh cookie, no new row). Anyone else gets the decoy.
      const parsed = presentedToken ? parseRequestToken(presentedToken) : null;
      if (parsed && parsed.id === open.id && (await argonVerify(open.tokenHash, parsed.secret).catch(() => false))) {
        const secret = randomBytes(32).toString('base64url');
        await this.prisma.passwordResetRequest.update({
          where: { id: open.id },
          data: { tokenHash: await argonHash(secret) },
        });
        await this.auditCreate(user.id, email, false, open.id, ctx);
        return {
          requestToken: `${PWRESET_REQUEST_TOKEN_PREFIX}${open.id}.${secret}`,
          requestTtlSeconds: ttlSeconds,
        };
      }
      return this.decoyOutcome(email, user.id, ttlSeconds, ctx);
    }

    // A16 cooldown: the newest row (ANY status — a fresh denial also counts) younger than the window
    // silently absorbs the call. Same neutral outcome; the owner-truth stays on the status endpoint.
    const cooldownSeconds =
      this.config.get<number>('PWRESET_REQUEST_COOLDOWN') ?? PWRESET_REQUEST_COOLDOWN_DEFAULT;
    if (cooldownSeconds > 0) {
      const newest = await this.prisma.passwordResetRequest.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (newest && newest.createdAt.getTime() > Date.now() - cooldownSeconds * 1000) {
        return this.decoyOutcome(email, user.id, ttlSeconds, ctx);
      }
    }

    // Create. The argon2id token hash runs BEFORE the transaction (never hold a tx open across argon)
    // and doubles as this branch's timing-equalizer (the decoy branches hash the decoy instead).
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const tokenHash = await argonHash(secret);
    const won = await this.prisma.$transaction(async (tx) => {
      // AUTHORITATIVE one-open-request guard: re-check inside the tx (the integrity.sql partial unique
      // index is only the prod backstop — db-push-provisioned DBs don't carry it).
      const stillOpen = await tx.passwordResetRequest.findFirst({
        where: { userId: user.id, status: PasswordResetRequestStatus.PENDING },
        select: { id: true },
      });
      if (stillOpen) return false;
      await tx.passwordResetRequest.create({
        data: {
          id,
          userId: user.id,
          tokenHash,
          ipHash: hashIp(ctx.ip),
          ipPrefix: ipPrefix(ctx.ip) || null,
          userAgent: ctx.userAgent ? ctx.userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        },
      });
      return true;
    });
    if (!won) {
      // Lost the single-open race to a concurrent create — same neutral outcome as the duplicate
      // branch. The argon work already ran above, so timing stays equalized; mint a fresh decoy.
      await this.auditCreate(user.id, email, false, null, ctx);
      return { requestToken: decoyRequestToken(), requestTtlSeconds: ttlSeconds };
    }

    await this.auditCreate(user.id, email, true, id, ctx);

    // Fan out to every admin-reset permission holder — BEST-EFFORT: a notification failure must never
    // fail the (already committed) request. dedupeKey = request id (a retried emit is a no-op).
    try {
      await this.notifications.emitToPermissionHolders(ADMIN_RESET_PERMISSION, {
        type: 'SECURITY_ALERT',
        severity: 'warning',
        titleKey: 'notifications.security.resetRequestCreated.title',
        bodyKey: 'notifications.security.resetRequestCreated.body',
        params: { account: maskEmail(email) },
        resourceType: 'password_reset_request',
        resourceId: id,
        dedupeKey: id,
      });
    } catch (error) {
      this.logger.warn(
        `Reset-request fan-out for ${id} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return { requestToken: `${PWRESET_REQUEST_TOKEN_PREFIX}${id}.${secret}`, requestTtlSeconds: ttlSeconds };
  }

  /**
   * Owner poll/claim, keyed ONLY by the ftd_pwreq cookie. NEVER 401/404 — a missing/malformed/decoy/
   * unknown token reads as 'pending' (indistinguishable from a real pending request, argon-equalized).
   * A real row is lazily expired, then its state maps 1:1 — except APPROVED-and-unclaimed, which CLAIMS
   * the approval: mint a standard reset challenge bound to THIS call's IP/UA, pre-stamp it
   * 'admin_approval', remember it as the request's latest challenge, and hand the token back so the
   * controller sets ftd_pwreset. Re-polling while approved re-mints (latest wins); after the reset
   * completed it stays 'approved' with no cookie.
   */
  async status(presentedToken: string | null, ctx: ResetContext): Promise<ResetRequestStatusResult> {
    const row = presentedToken ? await this.loadByToken(presentedToken) : null;
    if (!row) {
      // Timing parity with the real-row path (which argon-verifies the presented secret): a decoy/
      // unknown token must not be distinguishable from 'real but pending' by response time.
      await argonHash(DECOY_REQUEST);
      return { status: 'pending' };
    }

    // Lazy expiry: an over-age open row (pending OR approved-but-never-claimed) flips first.
    if (isOverdueOpen(row)) {
      await this.prisma.passwordResetRequest.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: PasswordResetRequestStatus.EXPIRED },
      });
      return { status: 'expired' };
    }

    switch (row.status) {
      case PasswordResetRequestStatus.PENDING:
        return { status: 'pending' };
      case PasswordResetRequestStatus.DENIED:
        return { status: 'denied' };
      case PasswordResetRequestStatus.EXPIRED:
        return { status: 'expired' };
      case PasswordResetRequestStatus.APPROVED:
      default: {
        if (row.completedAt) return { status: 'approved' }; // terminal — the reset already happened
        return this.claimApproval(row, ctx);
      }
    }
  }

  /** Admin list — lazily expires over-age open rows, then PENDING-first (enum order), newest first. */
  async list(statusFilter?: PasswordResetRequestStatus): Promise<ResetRequestItemDto[]> {
    await this.expireOverdue();
    const rows = await this.prisma.passwordResetRequest.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: ADMIN_LIST_TAKE,
      include: { user: { select: { displayName: true, email: true } } },
    });
    const deciders = await this.deciderNames(rows.map((r) => r.decidedBy));
    return rows.map((row) => toItemDto(row, deciders));
  }

  /** Admin detail — item + the §5 device metadata (coarse ipPrefix, UA summary, raw UA). */
  async detail(id: string): Promise<ResetRequestDetailDto> {
    const row = await this.loadForAdmin(id);
    if (isOverdueOpen(row)) {
      await this.prisma.passwordResetRequest.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: PasswordResetRequestStatus.EXPIRED },
      });
      row.status = PasswordResetRequestStatus.EXPIRED;
    }
    const deciders = await this.deciderNames([row.decidedBy]);
    return {
      ...toItemDto(row, deciders),
      ipPrefix: row.ipPrefix,
      deviceSummary: summarizeUserAgent(row.userAgent),
      userAgent: row.userAgent,
    };
  }

  /**
   * Admin decision. Guards, in order: 404 unknown id; 403 self-decision (an admin never approves their
   * own account's request — mirrors Auth.SelfResetForbidden on the direct admin reset); 409 expired
   * (lazy-flip then reject); 409 already decided (any other non-PENDING). The decision itself is an
   * atomic single-winner update (status must still be PENDING), then audit + a best-effort notification
   * to the REQUESTER, and the refreshed detail DTO is returned.
   */
  async decide(
    actorUserId: string,
    id: string,
    decision: typeof PasswordResetRequestStatus.APPROVED | typeof PasswordResetRequestStatus.DENIED,
  ): Promise<ResetRequestDetailDto> {
    const row = await this.loadForAdmin(id);

    if (row.userId === actorUserId) {
      throw new ForbiddenException({
        code: 'Auth.SelfResetForbidden',
        message: 'Use the self-service password reset to change your own password.',
      });
    }

    const now = new Date();
    if (row.status === PasswordResetRequestStatus.PENDING && row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.passwordResetRequest.updateMany({
        where: { id: row.id, status: PasswordResetRequestStatus.PENDING },
        data: { status: PasswordResetRequestStatus.EXPIRED },
      });
      throw expiredError();
    }
    if (row.status === PasswordResetRequestStatus.EXPIRED) throw expiredError();
    if (row.status !== PasswordResetRequestStatus.PENDING) throw alreadyDecidedError();

    // Single-winner decision: the PENDING guard makes a concurrent double-decide lose cleanly.
    const { count } = await this.prisma.passwordResetRequest.updateMany({
      where: { id: row.id, status: PasswordResetRequestStatus.PENDING },
      data: { status: decision, decidedBy: actorUserId, decidedAt: now },
    });
    if (count === 0) throw alreadyDecidedError();

    const approved = decision === PasswordResetRequestStatus.APPROVED;
    await this.audit.record({
      actorUserId,
      action: approved ? 'password.reset_request.approve' : 'password.reset_request.deny',
      resourceType: 'auth.password_reset_request',
      resourceId: row.id,
      outcome: 'SUCCESS',
      context: { targetUserId: row.userId },
    });

    // Durable receipt for the requester (visible after their next sign-in) — BEST-EFFORT: a
    // notification failure must never fail the committed decision.
    try {
      await this.notifications.emit({
        recipientUserId: row.userId,
        type: 'SECURITY_ALERT',
        severity: approved ? 'success' : 'warning',
        titleKey: approved
          ? 'notifications.security.resetRequestApproved.title'
          : 'notifications.security.resetRequestDenied.title',
        bodyKey: approved
          ? 'notifications.security.resetRequestApproved.body'
          : 'notifications.security.resetRequestDenied.body',
        params: {},
        resourceType: 'user',
        resourceId: row.userId,
      });
    } catch (error) {
      this.logger.warn(
        `Reset-request decision notification to ${row.userId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return this.detail(row.id);
  }

  // ---------- private ----------

  /**
   * Claim an APPROVED, unclaimed, unexpired request: mint a standard PASSWORD_RESET challenge bound to
   * the CLAIMING call's IP/UA, atomically pre-stamp it 'admin_approval' (the admin's identity check IS
   * the factor on this path), and remember it as the request's latest challenge (re-claims win). The
   * user must still be ACTIVE — anything else fail-closes to the neutral 'pending'.
   */
  private async claimApproval(
    row: { id: string; userId: string },
    ctx: ResetContext,
  ): Promise<ResetRequestStatusResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { status: true },
    });
    if (!user || user.status !== 'ACTIVE') return { status: 'pending' }; // fail-closed neutral

    const challengeTtlSeconds =
      this.config.get<number>('PWRESET_CHALLENGE_TTL') ?? PWRESET_CHALLENGE_TTL_DEFAULT;
    const { token, challengeId } = await this.challenges.create({
      userId: row.userId,
      purpose: PasswordResetPurpose.PasswordReset,
      ttlSeconds: challengeTtlSeconds,
      maxAttempts: this.config.get<number>('PWRESET_MAX_ATTEMPTS') ?? PWRESET_MAX_ATTEMPTS_DEFAULT,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // Pre-stamp the factor. A fresh unconsumed challenge always wins this; a false here is a DB
    // anomaly — fail closed to 'pending' (the next poll simply re-mints) rather than hand out a
    // challenge the password step would reject.
    if (!(await this.challenges.markFactorVerified(challengeId, 'admin_approval'))) {
      this.logger.warn(`Reset-request ${row.id}: factor pre-stamp lost on fresh challenge ${challengeId}.`);
      return { status: 'pending' };
    }
    await this.prisma.passwordResetRequest.update({
      where: { id: row.id },
      data: { challengeId },
    });
    await this.audit.record({
      actorUserId: row.userId,
      action: 'password.reset_request.claim',
      resourceType: 'auth.password_reset_request',
      resourceId: row.id,
      outcome: 'SUCCESS',
      context: {},
      ipHash: hashIp(ctx.ip),
    });
    return { status: 'approved', challengeToken: token, challengeTtlSeconds: challengeTtlSeconds };
  }

  /** The same neutral create outcome for every no-row branch: decoy argon work, ONE audit row, decoy token. */
  private async decoyOutcome(
    email: string,
    actorUserId: string | null,
    ttlSeconds: number,
    ctx: ResetContext,
  ): Promise<CreateResetRequestResult> {
    // Equalize timing with the real branch's argon2id token hash (mirrors initiate()'s decoy hash).
    await argonHash(DECOY_REQUEST);
    await this.auditCreate(actorUserId, email, false, null, ctx);
    return { requestToken: decoyRequestToken(), requestTtlSeconds: ttlSeconds };
  }

  /** Exactly ONE create-audit row per create() call — masked email only, created flag tells the branches apart. */
  private auditCreate(
    actorUserId: string | null,
    email: string,
    created: boolean,
    resourceId: string | null,
    ctx: ResetContext,
  ): Promise<void> {
    return this.audit.record({
      actorUserId,
      action: 'password.reset_request.create',
      resourceType: 'auth.password_reset_request',
      resourceId,
      outcome: 'SUCCESS',
      context: { email: maskEmail(email), created },
      ipHash: hashIp(ctx.ip),
    });
  }

  /** Validate a presented `pwq_…` token → the matching row, or null (fail-closed; no state distinction). */
  private async loadByToken(presented: string) {
    const parsed = parseRequestToken(presented);
    if (!parsed) return null;
    const row = await this.prisma.passwordResetRequest.findUnique({ where: { id: parsed.id } });
    if (!row) return null;
    if (!(await argonVerify(row.tokenHash, parsed.secret).catch(() => false))) return null;
    return row;
  }

  /** Admin row load with the account joined; 404 Auth.ResetRequestNotFound when unknown. */
  private async loadForAdmin(id: string): Promise<RequestWithUser> {
    const row = await this.prisma.passwordResetRequest.findUnique({
      where: { id },
      include: { user: { select: { displayName: true, email: true } } },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'Auth.ResetRequestNotFound',
        message: 'No such password-reset request.',
      });
    }
    return row;
  }

  /** Lazy expiry sweep: flip over-age open rows (PENDING, or APPROVED never completed) to EXPIRED. */
  private async expireOverdue(userId?: string): Promise<void> {
    await this.prisma.passwordResetRequest.updateMany({
      where: {
        ...(userId ? { userId } : {}),
        expiresAt: { lte: new Date() },
        OR: [
          { status: PasswordResetRequestStatus.PENDING },
          { status: PasswordResetRequestStatus.APPROVED, completedAt: null },
        ],
      },
      data: { status: PasswordResetRequestStatus.EXPIRED },
    });
  }

  /** Resolve decided_by ids (plain uuid column, no relation) to display labels — masked email fallback. */
  private async deciderNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => v !== null))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.displayName ?? maskEmail(u.email)]));
  }
}

/** Row (+ joined account) → admin item DTO. Emails ALWAYS masked; dates as ISO strings. */
function toItemDto(row: RequestWithUser, deciders: Map<string, string>): ResetRequestItemDto {
  return {
    id: row.id,
    account: { displayName: row.user.displayName, emailMasked: maskEmail(row.user.email) },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedByName: row.decidedBy ? (deciders.get(row.decidedBy) ?? null) : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

/** An open row (PENDING / APPROVED-unclaimed) past its expires_at — the lazy-expiry predicate. */
function isOverdueOpen(row: { status: PasswordResetRequestStatus; completedAt: Date | null; expiresAt: Date }): boolean {
  const open =
    row.status === PasswordResetRequestStatus.PENDING ||
    (row.status === PasswordResetRequestStatus.APPROVED && row.completedAt === null);
  return open && row.expiresAt.getTime() <= Date.now();
}

function expiredError(): ConflictException {
  return new ConflictException({
    code: 'Auth.ResetRequestExpired',
    message: 'The password-reset request has expired.',
  });
}

function alreadyDecidedError(): ConflictException {
  return new ConflictException({
    code: 'Auth.ResetRequestAlreadyDecided',
    message: 'The password-reset request was already decided.',
  });
}

/**
 * No-enumeration posture: a structurally-valid `pwq_<uuid>.<secret>` token referencing NO row — the
 * neutral-branch decoy handle. status() parses it, finds nothing, and fail-closes to 'pending'; it can
 * never surface request state. The secret is fresh random bytes (never stored, never compared).
 */
function decoyRequestToken(): string {
  return `${PWRESET_REQUEST_TOKEN_PREFIX}${uuidv7()}.${randomBytes(32).toString('base64url')}`;
}

/** Parse `pwq_<uuid>.<secret>`; returns `null` on any structural problem (fail-closed). */
function parseRequestToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(PWRESET_REQUEST_TOKEN_PREFIX)) return null;
  const rest = token.slice(PWRESET_REQUEST_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!isUuid(id) || !secret) return null;
  return { id, secret };
}

/**
 * Coarse network prefix for the admin display — copied from remembered-device.service.ts (private
 * there): IPv4 → /24 (first three octets), IPv6 → /48 (first three hextets). Unknown/empty input
 * collapses to '' (stored as null). NEVER a full IP at rest.
 */
function ipPrefix(ip?: string): string {
  if (!ip) return '';
  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : ip;
}

function hashIp(ip?: string): string | null {
  return ip ? createHash('sha256').update(ip).digest('hex') : null;
}
