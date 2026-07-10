/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Authenticated MFA self-service. JWT-guarded endpoints an operator uses
 * from Settings to enrol in opt-in MFA — separate from the @Public login-verify controller because the
 * auth context differs (a full Bearer session, not the challenge cookie). Thin: the logic lives in
 * MfaEnrollmentService. Management (disable / regenerate / admin-reset) lands here too.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  AdminResetMfaDto,
  ConfirmMfaSetupDto,
  MfaReauthDto,
  MfaSetupConfirmResponseDto,
  MfaSetupStartResponseDto,
  RememberedDeviceDto,
  StartMfaSetupDto,
} from '../mfa/dto/mfa.dto';
import { MfaEnrollmentService } from './mfa-enrollment.service';
import { MfaManagementService } from './mfa-management.service';

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // auth class: 10/min/IP

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/mfa')
export class MfaAccountController {
  constructor(
    private readonly enrollment: MfaEnrollmentService,
    private readonly management: MfaManagementService,
  ) {}

  @Post('setup/start')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOkResponse({
    type: MfaSetupStartResponseDto,
    description: 'Begin opt-in MFA enrolment (password re-auth). Returns the otpauth URI + QR to import into an authenticator app. MFA is NOT active until /setup/confirm.',
  })
  setupStart(@CurrentUser() principal: AuthPrincipal, @Body() dto: StartMfaSetupDto): Promise<MfaSetupStartResponseDto> {
    return this.enrollment.start(principal.sub, dto.password);
  }

  @Post('setup/confirm')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOkResponse({
    type: MfaSetupConfirmResponseDto,
    description: 'Confirm enrolment with the first code: activates MFA and returns the one-time backup codes (shown ONCE).',
  })
  setupConfirm(@CurrentUser() principal: AuthPrincipal, @Body() dto: ConfirmMfaSetupDto): Promise<MfaSetupConfirmResponseDto> {
    return this.enrollment.confirm(principal.sub, dto.code);
  }

  @Post('disable')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @ApiNoContentResponse({ description: 'Disable MFA (password + a current TOTP or backup code). Clears MFA state and revokes remembered devices.' })
  disable(@CurrentUser() principal: AuthPrincipal, @Body() dto: MfaReauthDto): Promise<void> {
    return this.management.disable(principal.sub, dto.password, dto.code);
  }

  @Post('backup-codes/regenerate')
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOkResponse({ type: MfaSetupConfirmResponseDto, description: 'Replace the backup codes (password + a current TOTP or backup code); returns the new set ONCE.' })
  regenerateBackupCodes(@CurrentUser() principal: AuthPrincipal, @Body() dto: MfaReauthDto): Promise<MfaSetupConfirmResponseDto> {
    return this.management.regenerateBackupCodes(principal.sub, dto.password, dto.code);
  }

  @Post('admin-reset')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('auth.mfa.admin_reset')
  @ApiNoContentResponse({ description: 'Administrator-only: reset a target operator’s MFA and revoke their sessions, devices, and live challenges.' })
  adminReset(@CurrentUser() principal: AuthPrincipal, @Body() dto: AdminResetMfaDto): Promise<void> {
    return this.management.adminReset(principal.sub, dto.userId);
  }

  @Get('devices')
  @ApiOkResponse({ type: [RememberedDeviceDto], description: 'List the operator’s active trusted ("remember this device") devices — empty when the feature is off.' })
  listDevices(@CurrentUser() principal: AuthPrincipal): Promise<RememberedDeviceDto[]> {
    return this.management.listDevices(principal.sub);
  }

  @Delete('devices/:id')
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @ApiNoContentResponse({ description: 'Revoke one of the operator’s own trusted devices (the next sign-in from it re-prompts for MFA).' })
  revokeDevice(@CurrentUser() principal: AuthPrincipal, @Param('id') id: string): Promise<void> {
    return this.management.revokeDevice(principal.sub, id);
  }
}
