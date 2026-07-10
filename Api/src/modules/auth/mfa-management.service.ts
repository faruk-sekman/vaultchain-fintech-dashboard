/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA management. Self-service disable + backup-code regeneration (password
 * re-auth PLUS a current second factor — TOTP or a one-time backup code), and an administrator reset of
 * another operator's enrolment. Every disable/reset CLEARS the MFA state and REVOKES the dependent
 * trust: backup codes, remembered devices (and, for admin-reset, refresh-token sessions + live
 * challenges) — so a compromised/lost factor can't keep a foothold. Secrets/codes never reach logs or
 * the audit context. Brute force on the second factor is bounded by the per-challenge counter on login;
 * here the JWT session already proves the operator, and the factor check is a confirmation step.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import { verify as argonVerify } from "@node-rs/argon2";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { BackupCodeService } from "../mfa/backup-code.service";
import {
  MfaSetupConfirmResponseDto,
  RememberedDeviceDto,
} from "../mfa/dto/mfa.dto";
import { RememberedDeviceService } from "../mfa/remembered-device.service";
import { TotpService } from "../mfa/totp.service";
import { NotificationService } from "../notification/notification.service";

/** The MFA-bearing fields a second-factor check needs. */
interface MfaUser {
  id: string;
  totpSecretEnc: string | null;
  lastUsedTotpStep: number | null;
}

@Injectable()
export class MfaManagementService {
  private readonly logger = new Logger(MfaManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly backupCodes: BackupCodeService,
    private readonly remembered: RememberedDeviceService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    // ModuleRef lets adminReset() pull NotificationService at call time WITHOUT importing NotificationModule
    // here. NotificationModule imports AuthModule (and RealtimeModule, which also imports AuthModule), so a
    // back-import would create an unresolvable module cycle. Lazy resolution sidesteps it; NotificationService
    // is global (exported by NotificationModule into AppModule), so { strict: false } finds it.
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Disable MFA: re-auth (password + a valid second factor), clear all MFA state, revoke remembered devices. */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
        totpSecretEnc: true,
        lastUsedTotpStep: true,
        mfaEnabled: true,
        mfaConfirmedAt: true,
      },
    });
    this.assertEnrolled(user.mfaEnabled, user.mfaConfirmedAt);
    await this.assertPassword(user.passwordHash, password);
    await this.assertSecondFactor(user, code);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: false,
          mfaConfirmedAt: null,
          totpSecretEnc: null,
          lastUsedTotpStep: null,
        },
      }),
      this.prisma.backupCode.deleteMany({ where: { userId } }),
      this.prisma.rememberedDevice.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      actorUserId: userId,
      action: "mfa.disable",
      resourceType: "auth.mfa",
      outcome: "SUCCESS",
    });
  }

  /** Regenerate backup codes: re-auth (password + a valid second factor); replaces the set, returns it ONCE. */
  async regenerateBackupCodes(
    userId: string,
    password: string,
    code: string,
  ): Promise<MfaSetupConfirmResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        passwordHash: true,
        totpSecretEnc: true,
        lastUsedTotpStep: true,
        mfaEnabled: true,
        mfaConfirmedAt: true,
      },
    });
    this.assertEnrolled(user.mfaEnabled, user.mfaConfirmedAt);
    await this.assertPassword(user.passwordHash, password);
    await this.assertSecondFactor(user, code);

    const backupCodes = await this.backupCodes.generate(
      userId,
      this.config.get<number>("MFA_BACKUP_CODE_COUNT") ?? 10,
    );
    await this.audit.record({
      actorUserId: userId,
      action: "mfa.backup_codes.regenerate",
      resourceType: "auth.mfa",
      outcome: "SUCCESS",
    });
    return { backupCodes };
  }

  /**
   * Administrator recovery: reset a target operator's MFA (the `auth.mfa.admin_reset` permission gate is
   * enforced at the controller). Clears MFA state and revokes the target's backup codes, refresh-token
   * sessions, remembered devices, and any live challenges — a full lockout reset. Audited with actor + target.
   */
  async adminReset(actorUserId: string, targetUserId: string): Promise<void> {
    // A self-reset via the admin path would bypass the password + second-factor re-auth that
    // self-service disable() enforces — forbidden for the highest-privilege role (security review).
    if (actorUserId === targetUserId) {
      throw new ForbiddenException({
        code: "Mfa.SelfResetForbidden",
        message: "Use POST /auth/mfa/disable to change your own MFA.",
      });
    }
    await this.prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: targetUserId },
        data: {
          mfaEnabled: false,
          mfaConfirmedAt: null,
          totpSecretEnc: null,
          lastUsedTotpStep: null,
        },
      }),
      this.prisma.backupCode.deleteMany({ where: { userId: targetUserId } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.rememberedDevice.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.mfaChallenge.updateMany({
        where: { userId: targetUserId, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      actorUserId,
      action: "mfa.admin_reset",
      resourceType: "auth.mfa",
      resourceId: targetUserId,
      outcome: "SUCCESS",
      context: { targetUserId },
    });

    // Residual: tell the TARGET operator their two-step verification was reset by an admin
    // (recipient-scoped SECURITY_ALERT — SEPARATE from the audit trail above). Recipient is the TARGET,
    // never the actor. PII-free (params stay {}). BEST-EFFORT: a notification failure must NEVER fail the
    // MFA reset, which has already committed; swallow + warn so the side effect can't undo the reset.
    try {
      const notifications = this.moduleRef.get(NotificationService, {
        strict: false,
      });
      await notifications.emit({
        recipientUserId: targetUserId,
        type: "SECURITY_ALERT",
        severity: "warning",
        titleKey: "notifications.security.adminMfaReset.title",
        bodyKey: "notifications.security.adminMfaReset.body",
        params: {},
        resourceType: "user",
        resourceId: targetUserId,
      });
    } catch (error) {
      this.logger.warn(
        `Admin-MFA-reset notification to ${targetUserId} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /** The operator's active remembered devices, for the self-service list. */
  listDevices(userId: string): Promise<RememberedDeviceDto[]> {
    return this.remembered.listActiveForUser(userId);
  }

  /** Revoke one of the operator's OWN remembered devices (scoped to userId); audited. */
  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    await this.remembered.revokeForUser(userId, deviceId);
    await this.audit.record({
      actorUserId: userId,
      action: "mfa.device.revoke",
      resourceType: "auth.mfa",
      resourceId: deviceId,
      outcome: "SUCCESS",
    });
  }

  /** Verify a 6-digit TOTP (advancing the replay floor) or a one-time backup code; throws 401 on mismatch. */
  private async assertSecondFactor(user: MfaUser, code: string): Promise<void> {
    const trimmed = code.trim();
    let ok: boolean;
    if (/^\d{6}$/.test(trimmed)) {
      ok = false;
      if (user.totpSecretEnc) {
        const secret = await this.totp.decryptSecret(
          user.totpSecretEnc,
          user.id,
        );
        const result = await this.totp.verify(
          secret,
          trimmed,
          user.lastUsedTotpStep,
        );
        if (result.ok) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { lastUsedTotpStep: result.usedStep },
          });
        }
        ok = result.ok;
      }
    } else {
      ok = await this.backupCodes.verify(user.id, trimmed);
    }
    if (!ok)
      throw new UnauthorizedException({
        code: "Mfa.InvalidCode",
        message: "Invalid second-factor code.",
      });
  }

  private async assertPassword(
    passwordHash: string,
    password: string,
  ): Promise<void> {
    if (!(await argonVerify(passwordHash, password).catch(() => false))) {
      throw new UnauthorizedException({
        code: "Auth.InvalidCredentials",
        message: "Invalid password.",
      });
    }
  }

  private assertEnrolled(
    mfaEnabled: boolean,
    mfaConfirmedAt: Date | null,
  ): void {
    if (!(mfaEnabled && mfaConfirmedAt)) {
      throw new BadRequestException({
        code: "Mfa.NotEnabled",
        message: "MFA is not enabled for this account.",
      });
    }
  }
}
