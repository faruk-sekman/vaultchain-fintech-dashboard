/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset module (self-service + admin fallback). Wires the
 * MFA-gated "forgot password" flow. It imports MfaModule to REUSE the existing TotpService +
 * BackupCodeService (call, don't reimplement) and AuthModule for the JwtAuthGuard + PermissionsGuard the
 * admin-reset controller is gated by (same as the feature modules). NotificationModule is imported so the
 * admin password reset can emit a recipient-scoped SECURITY_ALERT to the TARGET operator — no
 * cycle, since AuthModule (which NotificationModule imports) does not import this module.
 * Cross-cutting deps are already global: ConfigService (ConfigModule isGlobal), PrismaService, and
 * AuditService (AuditModule). Wired into AppModule alongside AuthModule (mirrors how MfaModule is consumed).
 */
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { MfaModule } from "../mfa/mfa.module";
import { NotificationModule } from "../notification/notification.module";
import { PasswordResetChallengeGuard } from "./guards/password-reset-challenge.guard";
import { PasswordResetAdminController } from "./password-reset-admin.controller";
import { PasswordResetChallengeService } from "./password-reset-challenge.service";
import { PasswordResetController } from "./password-reset.controller";
import { PasswordResetRequestAdminController } from "./password-reset-request-admin.controller";
import { PasswordResetRequestController } from "./password-reset-request.controller";
import { PasswordResetRequestService } from "./password-reset-request.service";
import { PasswordResetService } from "./password-reset.service";

// A15/A16 additions ride in this module: the @Public reset-request pair (create + status/claim) and the
// admin queue controller reuse the SAME imports — NotificationModule for the permission-holder fan-out /
// requester receipts, AuthModule for the admin controller's guards, and the challenge service to mint
// the pre-stamped 'admin_approval' challenge the existing /reset/verify endpoint consumes.
@Module({
  imports: [MfaModule, AuthModule, NotificationModule],
  controllers: [
    PasswordResetController,
    PasswordResetAdminController,
    PasswordResetRequestController,
    PasswordResetRequestAdminController,
  ],
  providers: [
    PasswordResetService,
    PasswordResetChallengeService,
    PasswordResetChallengeGuard,
    PasswordResetRequestService,
  ],
  exports: [PasswordResetChallengeService],
})
export class PasswordResetModule {}
