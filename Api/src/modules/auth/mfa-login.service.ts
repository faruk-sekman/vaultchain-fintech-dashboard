/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA login completion. Owns the second-factor verify business logic so the
 * controller stays thin: validate the LOGIN challenge, check the factor (TOTP against its replay floor,
 * or a one-time backup code), atomically consume the single-use challenge, issue a fresh session (the
 * session-fixation upgrade), optionally mint a remember-device token, and audit. It returns the values
 * the controller turns into cookies; it never touches HTTP. Codes, secrets and tokens never reach logs
 * or the audit context. Brute force is bounded per-challenge (attempt counter) — no account lockout.
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BackupCodeService } from '../mfa/backup-code.service';
import { MfaChallengeService, OpenChallenge } from '../mfa/mfa-challenge.service';
import { MfaPurpose } from '../mfa/mfa.constants';
import { RememberedDeviceService } from '../mfa/remembered-device.service';
import { TotpService } from '../mfa/totp.service';
import { NotificationService } from '../notification/notification.service';
import { AuthService, SessionResult } from './auth.service';

type VerifyMethod = 'totp' | 'backup_code';

export interface MfaLoginContext {
  ip?: string;
  userAgent?: string;
}

/** What the controller needs to finish the HTTP response — set the cookies and return the body. */
export interface MfaLoginResult {
  session: SessionResult;
  rememberDevice?: { token: string; ttlSeconds: number };
}

@Injectable()
export class MfaLoginService {
  private readonly logger = new Logger(MfaLoginService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly backupCodes: BackupCodeService,
    private readonly challenges: MfaChallengeService,
    private readonly remembered: RememberedDeviceService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    // ModuleRef lets complete() pull NotificationService at call time WITHOUT importing NotificationModule
    // here. NotificationModule imports AuthModule (and RealtimeModule, which also imports AuthModule), so a
    // back-import would create an unresolvable module cycle. Lazy resolution sidesteps it; NotificationService
    // is global, so { strict: false } finds it (mirrors MfaManagementService).
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Verify a TOTP code for the in-progress login challenge. */
  async verifyTotp(challenge: OpenChallenge, code: string, rememberDevice: boolean, ctx: MfaLoginContext): Promise<MfaLoginResult> {
    this.assertLoginChallenge(challenge);
    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: { id: true, totpSecretEnc: true, lastUsedTotpStep: true },
    });
    if (!user?.totpSecretEnc) return this.reject(challenge, ctx, 'totp');

    const secret = await this.totp.decryptSecret(user.totpSecretEnc, user.id);
    const result = await this.totp.verify(secret, code, user.lastUsedTotpStep);
    if (!result.ok) return this.reject(challenge, ctx, 'totp');

    // Advance the replay floor BEFORE issuing the session so the accepted code can never be re-used.
    await this.prisma.user.update({ where: { id: challenge.userId }, data: { lastUsedTotpStep: result.usedStep } });
    return this.complete(challenge, rememberDevice, ctx, 'totp');
  }

  /** Redeem a one-time backup code for the in-progress login challenge (recovery path — no remember). */
  async verifyBackupCode(challenge: OpenChallenge, code: string, ctx: MfaLoginContext): Promise<MfaLoginResult> {
    this.assertLoginChallenge(challenge);
    if (!(await this.backupCodes.verify(challenge.userId, code))) return this.reject(challenge, ctx, 'backup_code');
    return this.complete(challenge, false, ctx, 'backup_code');
  }

  /** Only a LOGIN-purpose challenge upgrades a session here (an ENROLL challenge is confirmed elsewhere). */
  private assertLoginChallenge(challenge: OpenChallenge): void {
    if (challenge.purpose !== MfaPurpose.Login) {
      throw new UnauthorizedException({ code: 'Mfa.WrongChallenge', message: 'No login challenge in progress.' });
    }
  }

  /** Count the bad attempt (the challenge fails closed at maxAttempts), audit, and throw a generic 401. */
  private async reject(challenge: OpenChallenge, ctx: MfaLoginContext, method: VerifyMethod): Promise<never> {
    await this.challenges.registerFailedAttempt(challenge.id);
    await this.audit.record({
      actorUserId: challenge.userId,
      action: 'mfa.verify',
      resourceType: 'auth.session',
      outcome: 'FAIL',
      context: { method, reason: 'invalid_code' },
      ipHash: hashIp(ctx.ip),
    });
    throw new UnauthorizedException({ code: 'Mfa.InvalidCode', message: 'Invalid or expired code.' });
  }

  /** Atomically consume the challenge, issue the session, optionally remember the device, and audit. */
  private async complete(challenge: OpenChallenge, rememberDevice: boolean, ctx: MfaLoginContext, method: VerifyMethod): Promise<MfaLoginResult> {
    if (!(await this.challenges.consume(challenge.id))) {
      // Lost the single-use race — another request already upgraded this challenge to a session.
      throw new UnauthorizedException({ code: 'Mfa.ChallengeConsumed', message: 'The MFA challenge was already used.' });
    }

    const session = await this.auth.issueSessionForUser(challenge.userId);
    let remember: MfaLoginResult['rememberDevice'];
    if (rememberDevice && (this.config.get<boolean>('MFA_REMEMBER_DEVICE_ENABLED') ?? false)) {
      const ttlSeconds = this.config.get<number>('MFA_REMEMBER_DEVICE_TTL') ?? 2_592_000;
      const device = await this.remembered.issue(challenge.userId, ttlSeconds, { ip: ctx.ip, userAgent: ctx.userAgent });
      remember = { token: device.token, ttlSeconds };
      // A NEW trusted device was just minted for this account — tell the operator (residual).
      // Only fires when a device is actually issued (inside this branch, after issue()); a login without
      // "remember", or with the feature flag off, emits nothing. Recipient is the authenticated user.
      await this.notifyNewTrustedDevice(challenge.userId);
    }

    await this.audit.record({
      actorUserId: challenge.userId,
      action: 'mfa.verify',
      resourceType: 'auth.session',
      outcome: 'SUCCESS',
      context: { method },
      ipHash: hashIp(ctx.ip),
    });
    return { session, rememberDevice: remember };
  }

  /**
   * Best-effort recipient-scoped new-trusted-device alert (residual). Lazily resolves
   * NotificationService (avoids the Auth↔Notification↔Realtime module cycle) and emits a SECURITY_ALERT.
   * PII-FREE (params stay {} — NEVER ip/userAgent; the params-guard rejects those). BEST-EFFORT: a
   * notification failure must NEVER fail the MFA login, which has already issued a session; swallow + warn.
   */
  private async notifyNewTrustedDevice(userId: string): Promise<void> {
    try {
      const notifications = this.moduleRef.get(NotificationService, { strict: false });
      await notifications.emit({
        recipientUserId: userId,
        type: 'SECURITY_ALERT',
        severity: 'warning',
        titleKey: 'notifications.security.newTrustedDevice.title',
        bodyKey: 'notifications.security.newTrustedDevice.body',
        params: {},
        resourceType: 'auth.trustedDevice',
      });
    } catch (error) {
      this.logger.warn(
        `New-trusted-device notification to ${userId} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

function hashIp(ip?: string): string | null {
  return ip ? createHash('sha256').update(ip).digest('hex') : null;
}
