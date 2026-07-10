/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA module. Wires the four single-responsibility MFA services + the
 * challenge guard. Their cross-cutting dependencies are already global: ConfigService (ConfigModule
 * isGlobal), the PII envelope encryptor (CryptoModule @Global, the TOTP secret reuses it), and
 * PrismaService. The auth controller consumes the exported services to wire the login
 * decision tree + the /auth/mfa verify/enrolment/management endpoints.
 */
import { Module } from '@nestjs/common';
import { BackupCodeService } from './backup-code.service';
import { MfaChallengeService } from './mfa-challenge.service';
import { RememberedDeviceService } from './remembered-device.service';
import { TotpService } from './totp.service';
import { MfaChallengeGuard } from './guards/mfa-challenge.guard';

const providers = [TotpService, BackupCodeService, MfaChallengeService, RememberedDeviceService, MfaChallengeGuard];

@Module({
  providers,
  exports: providers,
})
export class MfaModule {}
