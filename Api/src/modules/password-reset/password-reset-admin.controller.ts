/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Administrator password-reset fallback. JWT-guarded, permission-gated endpoint
 * an Administrator uses to set a working password for an operator who CANNOT self-serve the @Public,
 * MFA-gated /auth/password/reset flow (e.g. no MFA enrolled, or locked out). Separate controller from the
 * @Public self-service one because the auth context differs (a full Bearer session + the
 * `auth.password.admin_reset` permission, not the challenge cookie). Thin: the logic lives in
 * PasswordResetService.adminReset. Mirrors the MFA admin-reset (mfa-account.controller.ts). The new
 * password is never logged — the request body is never written to logs.
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AdminPasswordResetDto } from './dto/admin-password-reset.dto';
import { PasswordResetService } from './password-reset.service';

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // auth class: 10/min/IP

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/password')
export class PasswordResetAdminController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Post('admin-reset')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('auth.password.admin_reset')
  @ApiNoContentResponse({
    description:
      'Administrator-only: set a working password for a target operator who cannot self-serve the MFA-gated reset, and revoke their sessions, devices, and live challenges. No session/token is issued. Self-reset via this path is forbidden (use the self-service reset).',
  })
  adminReset(@CurrentUser() principal: AuthPrincipal, @Body() dto: AdminPasswordResetDto): Promise<void> {
    return this.passwordReset.adminReset(principal.sub, dto.targetUserId, dto.newPassword);
  }
}
