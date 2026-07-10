/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Auth module. Configures the JWT signer/verifier and exposes the reusable
 * JwtAuthGuard + PermissionsGuard so feature modules can gate their controllers.
 *
 * MfaManagementService.adminReset emits a best-effort recipient-scoped SECURITY_ALERT to the target
 * operator (residual). It does NOT import NotificationModule here — NotificationModule
 * imports AuthModule (and RealtimeModule, which also imports AuthModule), so a back-import would create a
 * module cycle. Instead MfaManagementService resolves NotificationService lazily via ModuleRef.
 */
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/auth/permissions.guard";
import { MfaModule } from "../mfa/mfa.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MfaAccountController } from "./mfa-account.controller";
import { MfaController } from "./mfa.controller";
import { MfaEnrollmentService } from "./mfa-enrollment.service";
import { MfaLoginService } from "./mfa-login.service";
import { MfaManagementService } from "./mfa-management.service";

@Module({
  imports: [
    MfaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_ACCESS_SECRET"),
        signOptions: { expiresIn: "15m" },
      }),
    }),
  ],
  controllers: [AuthController, MfaController, MfaAccountController],
  providers: [
    AuthService,
    MfaLoginService,
    MfaEnrollmentService,
    MfaManagementService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [JwtAuthGuard, PermissionsGuard, JwtModule],
})
export class AuthModule {}
