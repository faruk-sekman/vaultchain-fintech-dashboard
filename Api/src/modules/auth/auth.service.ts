/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Authentication service. Verifies credentials with Argon2id, issues a 15-min JWT
 * carrying the principal's effective permission codes, and manages refresh-token sessions:
 * rotation on every use, reuse detection (revoke all sessions), logout, and account lockout after
 * repeated failures. Generic errors avoid user-enumeration; every attempt is audited.
 *
 * Refresh tokens are `rt_<id>.<secret>`: the `id` is the DB lookup key, the `secret` is verified
 * against the stored Argon2id `token_hash`.
 */
import { HttpException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import type { User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { maskEmail } from '../../common/util/mask';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MfaChallengeService } from '../mfa/mfa-challenge.service';
import { MfaPurpose } from '../mfa/mfa.constants';
import { RememberedDeviceService } from '../mfa/remembered-device.service';
import { NotificationService } from '../notification/notification.service';
import { LoginResponseDto, MeResponseDto } from './dto/auth-response.dto';

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day session family
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Name of the httpOnly cookie that carries the refresh token. */
export const REFRESH_COOKIE_NAME = 'ftd_refresh';
/** Path scope: the cookie is only ever sent to the auth endpoints that rotate/revoke it. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * httpOnly cookie attributes for the refresh token. `secure` is gated to production: on
 * http://localhost a Secure cookie would never be stored, so it MUST be false in dev/local.
 * httpOnly (no JS access → XSS can't read it) + SameSite=Strict + the path scope above keep the
 * CSRF surface minimal. maxAge mirrors the refresh-token TTL so the cookie and the DB session
 * expire together.
 */
export function refreshCookieOptions(): {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(REFRESH_TTL_MS / 1000), // seconds
  };
}

/** A response body paired with the refresh-token string the controller sets as the cookie. */
export interface SessionResult {
  body: LoginResponseDto;
  refreshToken: string;
}

/** Request context the login decision tree needs. All optional — absent = no signal. */
export interface LoginContext {
  ip?: string;
  userAgent?: string;
  /** The presented `ftd_remember` device token, if any (enables the trusted-device fast-path). */
  rememberDeviceToken?: string;
}

/**
 * The outcome of a password login. `authenticated` carries a ready session; `mfa_required`
 * carries the opaque challenge the controller sets as the `ftd_mfa` cookie — NO session is issued yet.
 */
export type LoginOutcome =
  | { status: 'authenticated'; session: SessionResult }
  | { status: 'mfa_required'; challengeToken: string; challengeTtlSeconds: number };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly challenges: MfaChallengeService,
    private readonly remembered: RememberedDeviceService,
    // ModuleRef lets registerFailure() pull NotificationService at call time WITHOUT importing
    // NotificationModule here. NotificationModule imports AuthModule (and RealtimeModule, which also
    // imports AuthModule), so a back-import would create an unresolvable module cycle. Lazy resolution
    // sidesteps it; NotificationService is global, so { strict: false } finds it (mirrors MfaManagementService).
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Verify credentials and decide the second-factor outcome (opt-in). A correct password no
   * longer always grants a session: an MFA-enrolled user gets a short-lived challenge instead, and a
   * full session is issued only after the second factor (or via a trusted-device fast-path). The lock /
   * audit / no-enumeration behaviour is unchanged.
   */
  async login(emailRaw: string, password: string, ctx?: LoginContext): Promise<LoginOutcome> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Locked account → 423 before any password work (no enumeration: only reachable post-failures).
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.recordAttempt(user.id, email, false, 'locked', ctx?.ip);
      throw new HttpException(
        { code: 'Auth.AccountLocked', message: 'Account temporarily locked after repeated failures.' },
        423,
      );
    }

    const verified = !!user && user.status === 'ACTIVE' && (await verify(user.passwordHash, password).catch(() => false));
    if (!user || !verified) {
      if (user) await this.registerFailure(user.id, user.failedLoginCount, email, ctx?.ip);
      else await this.recordAttempt(null, email, false, 'unknown_user', ctx?.ip);
      throw new UnauthorizedException({ code: 'Auth.InvalidCredentials', message: 'Invalid email or password.' });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    await this.recordAttempt(user.id, email, true, null, ctx?.ip);
    return this.decideSecondFactor(user, ctx);
  }

  /**
   * Opt-in second-factor decision after a verified password:
   *   (a) a valid trusted-device token for THIS user → full session (skip MFA), when the feature is on;
   *   (b) the user has confirmed MFA → a single-use challenge, NO session yet (status `mfa_required`);
   *   (c) otherwise (MFA off, the opt-in default) → a full session.
   * There is intentionally no `enrollment_required` branch — MFA is never forced.
   */
  private async decideSecondFactor(user: User, ctx?: LoginContext): Promise<LoginOutcome> {
    if ((this.config.get<boolean>('MFA_REMEMBER_DEVICE_ENABLED') ?? false) && ctx?.rememberDeviceToken) {
      const trusted = await this.remembered.verify(ctx.rememberDeviceToken, { ip: ctx.ip, userAgent: ctx.userAgent });
      if (trusted?.userId === user.id) {
        return { status: 'authenticated', session: await this.issueSession(user.id, uuidv7()) };
      }
    }

    if (user.mfaEnabled && user.mfaConfirmedAt) {
      const ttlSeconds = this.config.get<number>('MFA_CHALLENGE_TTL') ?? 300;
      const { token } = await this.challenges.create({
        userId: user.id,
        purpose: MfaPurpose.Login,
        ttlSeconds,
        maxAttempts: this.config.get<number>('MFA_MAX_VERIFY_ATTEMPTS') ?? 5,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
      return { status: 'mfa_required', challengeToken: token, challengeTtlSeconds: ttlSeconds };
    }

    // Mandatory-MFA fail-closed (F3 / CWE-287). MFA_REQUIRED is org-wide policy (default false → the
    // opt-in default is unchanged). When it is ON and this user has NOT confirmed a second factor (and
    // reached here without a trusted device), refuse to issue a session — MFA must be set up first.
    // ConfigService can hand this back as a boolean (validated) OR a raw env STRING, so treat ONLY an
    // explicit true / 'true' as mandatory — a 'false' string must never accidentally enforce (which would
    // otherwise lock out every non-enrolled user, including the demo seed accounts).
    const mfaRequired = this.config.get<boolean | string>('MFA_REQUIRED');
    if (mfaRequired === true || mfaRequired === 'true') {
      throw new HttpException(
        { code: 'Auth.MfaEnrollmentRequired', message: 'Multi-factor authentication must be set up before signing in.' },
        403,
      );
    }

    return { status: 'authenticated', session: await this.issueSession(user.id, uuidv7()) };
  }

  /** Rotate a refresh token. Reuse of a revoked token revokes ALL of the user's sessions. */
  async refresh(presented: string): Promise<SessionResult> {
    const parsed = this.parseRefreshToken(presented);
    const row = parsed && (await this.prisma.refreshToken.findUnique({ where: { id: parsed.id } }));
    if (!parsed || !row) {
      throw new UnauthorizedException({ code: 'Auth.InvalidToken', message: 'Invalid refresh token.' });
    }

    if (row.revokedAt) {
      // Reuse detected: a token that was already rotated is presented again.
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh-token reuse detected for user ${row.userId}; all sessions revoked.`);
      throw new UnauthorizedException({ code: 'Auth.TokenReused', message: 'Refresh token reuse detected; sessions revoked.' });
    }
    if (row.expiresAt.getTime() <= Date.now() || !(await verify(row.tokenHash, parsed.secret).catch(() => false))) {
      throw new UnauthorizedException({ code: 'Auth.InvalidToken', message: 'Invalid or expired refresh token.' });
    }

    // Rotate within the same session family: revoke the old, mint the new, atomically.
    const newId = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const tokenHash = await hash(secret);
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(), replacedById: newId } }),
      this.prisma.refreshToken.create({
        data: { id: newId, tokenHash, userId: row.userId, sessionId: row.sessionId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
      }),
    ]);
    return this.buildResponse(row.userId, `rt_${newId}.${secret}`);
  }

  /**
   * Revoke the presented token's whole session family. Idempotent (unknown token → no-op 204).
   * Now that logout is @Public (FND-011), the presented `secret` is verified against
   * the stored hash before revoking — possessing only a token `id` must not let anyone revoke a
   * session family. The cookie is still cleared by the controller regardless (best-effort cleanup).
   */
  async logout(presented: string): Promise<void> {
    const parsed = this.parseRefreshToken(presented);
    if (!parsed) return;
    const row = await this.prisma.refreshToken.findUnique({ where: { id: parsed.id } });
    if (!row) return;
    if (!(await verify(row.tokenHash, parsed.secret).catch(() => false))) return;
    await this.prisma.refreshToken.updateMany({
      where: { sessionId: row.sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<MeResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, displayName: true, email: true, mfaEnabled: true, lastLoginAt: true },
    });
    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: maskEmail(user.email),
        mfaEnabled: user.mfaEnabled,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      },
      permissions: await this.resolvePermissions(userId),
    };
  }

  /** Issue a fresh session for a user after a verified second factor (the MFA → full-session upgrade). */
  issueSessionForUser(userId: string): Promise<SessionResult> {
    return this.issueSession(userId, uuidv7());
  }

  private async issueSession(userId: string, sessionId: string): Promise<SessionResult> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: { id, tokenHash: await hash(secret), userId, sessionId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    return this.buildResponse(userId, `rt_${id}.${secret}`);
  }

  /**
   * Build the body DTO (access token + profile + permissions) and pair it with the refresh-token
   * string the controller sets as the httpOnly cookie. The refresh token never goes in the body.
   */
  private async buildResponse(userId: string, refreshToken: string): Promise<SessionResult> {
    const permissions = await this.resolvePermissions(userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, displayName: true, email: true, mfaEnabled: true, permissionVersion: true, lastLoginAt: true },
    });
    // Embed the permission-snapshot version (audit F9): PermissionsGuard rejects a token whose `pv` no
    // longer matches the user's current permissionVersion, so an RBAC change applies before token TTL.
    const accessToken = await this.jwt.signAsync({ sub: userId, permissions, pv: user.permissionVersion });
    return {
      refreshToken,
      body: {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: ACCESS_TTL_SECONDS,
        permissions,
        user: {
          id: user.id,
          displayName: user.displayName,
          email: maskEmail(user.email),
          mfaEnabled: user.mfaEnabled,
          // Login stamps lastLoginAt BEFORE the session is built, so this reflects the sign-in that
          // issued this very session — exactly what the Settings "last sign-in" readout shows.
          lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        },
      },
    };
  }

  private async registerFailure(userId: string, currentCount: number, email: string, ip?: string): Promise<void> {
    const failed = currentCount + 1;
    const locked = failed >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: failed, lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null },
    });
    await this.recordAttempt(userId, email, false, 'bad_password', ip);
    // Notify the locked operator ONLY on the failure that TRANSITIONS the account to locked (the same
    // condition that sets lockedUntil) — earlier non-locking failures emit nothing. The dedupeKey bounds
    // repeated attempts while already locked to one row. Recipient is the locked user. PII-FREE (params
    // stay {} — NEVER ip/email/userAgent; the params-guard rejects those and they must not be persisted).
    if (locked) await this.notifyAccountLockout(userId);
  }

  /**
   * Best-effort recipient-scoped lockout alert (residual). Lazily resolves NotificationService
   * (avoids the Auth↔Notification↔Realtime module cycle) and emits a SECURITY_ALERT. BEST-EFFORT: a
   * notification failure must NEVER fail the login/lockout path, which has already committed; swallow + warn.
   */
  private async notifyAccountLockout(userId: string): Promise<void> {
    try {
      const notifications = this.moduleRef.get(NotificationService, { strict: false });
      await notifications.emit({
        recipientUserId: userId,
        type: 'SECURITY_ALERT',
        severity: 'critical',
        titleKey: 'notifications.security.accountLockout.title',
        bodyKey: 'notifications.security.accountLockout.body',
        params: {},
        resourceType: 'auth.account',
        resourceId: userId,
        dedupeKey: `lockout:${userId}`,
      });
    } catch (error) {
      this.logger.warn(
        `Account-lockout notification to ${userId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async recordAttempt(
    userId: string | null,
    email: string,
    success: boolean,
    failureReason: string | null,
    ip?: string,
  ): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: {
        id: uuidv7(),
        userId,
        emailHash: userId ? null : sha256(email),
        success,
        failureReason,
        ipHash: ip ? sha256(ip) : null,
      },
    });
  }

  private parseRefreshToken(token: string): { id: string; secret: string } | null {
    if (!token.startsWith('rt_')) return null;
    const rest = token.slice(3);
    const dot = rest.indexOf('.');
    if (dot <= 0) return null;
    const id = rest.slice(0, dot);
    const secret = rest.slice(dot + 1);
    if (!UUID_RE.test(id) || !secret) return null;
    return { id, secret };
  }

  /** Effective permission codes = union over the user's roles' permissions. */
  private async resolvePermissions(userId: string): Promise<string[]> {
    const rows = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        userRoles: {
          select: {
            role: { select: { rolePermissions: { select: { permission: { select: { code: true } } } } } },
          },
        },
      },
    });
    const codes = new Set<string>();
    for (const userRole of rows?.userRoles ?? []) {
      for (const rp of userRole.role.rolePermissions) codes.add(rp.permission.code);
    }
    return [...codes].sort();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
