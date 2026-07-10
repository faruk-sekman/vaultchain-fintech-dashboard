/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA enrolment. Opt-in, performed from a full session (the JWT identifies
 * the operator) with a password re-auth on `start` for this sensitive change. `start` generates a TOTP
 * secret and stores it ENCRYPTED + INACTIVE (mfaConfirmedAt stays null) — MFA is never active until the
 * first correct code is `confirm`-ed, which also mints the one-time backup codes (returned ONCE). A
 * second enrolment while already enabled is a 409. Secrets/codes never reach logs or the audit context.
 */
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verify as argonVerify } from '@node-rs/argon2';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { BackupCodeService } from '../mfa/backup-code.service';
import { MfaSetupConfirmResponseDto, MfaSetupStartResponseDto } from '../mfa/dto/mfa.dto';
import { TotpService } from '../mfa/totp.service';

@Injectable()
export class MfaEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly backupCodes: BackupCodeService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Begin enrolment: re-auth the password, store an INACTIVE encrypted secret, return the URI + QR. */
  async start(userId: string, password: string): Promise<MfaSetupStartResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, mfaEnabled: true, mfaConfirmedAt: true },
    });
    await this.assertPassword(user.passwordHash, password);
    this.assertNotEnrolled(user.mfaEnabled, user.mfaConfirmedAt);

    const secret = this.totp.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      // Inactive: the secret is stored but MFA stays off until `confirm`. Reset the replay floor so the
      // first confirming code is always accepted; a re-start overwrites any prior in-progress secret.
      data: { totpSecretEnc: await this.totp.encryptSecret(secret, userId), mfaEnabled: false, mfaConfirmedAt: null, lastUsedTotpStep: null },
    });
    const otpauthUri = this.totp.keyUri(user.email, secret);
    await this.audit.record({ actorUserId: userId, action: 'mfa.enroll.start', resourceType: 'auth.mfa', outcome: 'SUCCESS' });
    return { otpauthUri, qrDataUrl: await this.totp.qrDataUrl(otpauthUri) };
  }

  /** Confirm enrolment: the first correct code activates MFA and returns the one-time backup codes. */
  async confirm(userId: string, code: string): Promise<MfaSetupConfirmResponseDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, totpSecretEnc: true, lastUsedTotpStep: true, mfaEnabled: true, mfaConfirmedAt: true },
    });
    this.assertNotEnrolled(user.mfaEnabled, user.mfaConfirmedAt);
    if (!user.totpSecretEnc) {
      throw new BadRequestException({ code: 'Mfa.NoSetupInProgress', message: 'Start MFA setup before confirming.' });
    }

    const secret = await this.totp.decryptSecret(user.totpSecretEnc, userId);
    const result = await this.totp.verify(secret, code, user.lastUsedTotpStep);
    if (!result.ok) {
      throw new UnauthorizedException({ code: 'Mfa.InvalidCode', message: 'Invalid or expired code.' });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaConfirmedAt: new Date(), lastUsedTotpStep: result.usedStep },
    });
    const backupCodes = await this.backupCodes.generate(userId, this.config.get<number>('MFA_BACKUP_CODE_COUNT') ?? 10);
    await this.audit.record({ actorUserId: userId, action: 'mfa.enroll.confirm', resourceType: 'auth.mfa', outcome: 'SUCCESS' });
    return { backupCodes };
  }

  private async assertPassword(passwordHash: string, password: string): Promise<void> {
    if (!(await argonVerify(passwordHash, password).catch(() => false))) {
      throw new UnauthorizedException({ code: 'Auth.InvalidCredentials', message: 'Invalid password.' });
    }
  }

  private assertNotEnrolled(mfaEnabled: boolean, mfaConfirmedAt: Date | null): void {
    if (mfaEnabled && mfaConfirmedAt) {
      throw new ConflictException({ code: 'Mfa.AlreadyEnrolled', message: 'MFA is already enabled for this account.' });
    }
  }
}
