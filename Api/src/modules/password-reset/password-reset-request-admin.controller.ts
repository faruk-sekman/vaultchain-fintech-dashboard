/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Administrator surface for the A15 reset requests. JWT-guarded (class level) + permission-gated per
 * route on the SAME `auth.password.admin_reset` permission as the direct admin reset (mirrors
 * PasswordResetAdminController). Thin: the logic lives in PasswordResetRequestService.
 *
 *   GET  /auth/password/reset-requests          — list (PENDING first via enum order, newest first;
 *                                                 optional ?status= filter; take 100, no pagination v1).
 *   GET  /auth/password/reset-requests/:id      — detail incl. coarse device metadata (ipPrefix /
 *                                                 deviceSummary / raw UA). Raw IP is never stored/shown.
 *   POST /auth/password/reset-requests/:id/approve — approve (identity verified OUT-OF-BAND by the
 *                                                 admin); the requester's polling browser then claims a
 *                                                 pre-stamped set-password challenge. 10/min throttled.
 *   POST /auth/password/reset-requests/:id/deny — same contract, decision DENIED.
 *
 * Stable errors: 404 Auth.ResetRequestNotFound · 409 Auth.ResetRequestAlreadyDecided · 409
 * Auth.ResetRequestExpired · 403 Auth.SelfResetForbidden (an admin never decides their own request).
 * Every DTO field is masked-only (emails via maskEmail); no token/secret ever appears in a response.
 */
import { BadRequestException, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PasswordResetRequestStatus } from '@prisma/client';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { ResetRequestDetailDto, ResetRequestItemDto } from './dto/reset-request.dto';
import { ADMIN_RESET_PERMISSION, PasswordResetRequestService } from './password-reset-request.service';

const DECIDE_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // auth class: 10/min/IP

@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/password/reset-requests')
export class PasswordResetRequestAdminController {
  constructor(private readonly resetRequests: PasswordResetRequestService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(ADMIN_RESET_PERMISSION)
  @ApiQuery({ name: 'status', required: false, description: 'PENDING | APPROVED | DENIED | EXPIRED' })
  @ApiOkResponse({
    type: [ResetRequestItemDto],
    description:
      'Administrator-only: the reset-request queue, PENDING first, newest first (max 100). Account emails are ALWAYS masked.',
  })
  list(@Query('status') status?: string): Promise<ResetRequestItemDto[]> {
    return this.resetRequests.list(parseStatusFilter(status));
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(ADMIN_RESET_PERMISSION)
  @ApiOkResponse({
    type: ResetRequestDetailDto,
    description:
      'Administrator-only: one reset request incl. coarse device metadata (ipPrefix — never a raw IP — plus a User-Agent summary and the raw UA). 404 Auth.ResetRequestNotFound when unknown.',
  })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ResetRequestDetailDto> {
    return this.resetRequests.detail(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Throttle(DECIDE_THROTTLE)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(ADMIN_RESET_PERMISSION)
  @ApiOkResponse({
    type: ResetRequestDetailDto,
    description:
      "Approve a pending reset request (verify the requester's identity OUT-OF-BAND first). The requester's polling browser then claims a factor-pre-stamped set-password challenge — the admin never chooses or sees a password. Returns the refreshed detail. Errors: 404 Auth.ResetRequestNotFound · 409 Auth.ResetRequestAlreadyDecided · 409 Auth.ResetRequestExpired · 403 Auth.SelfResetForbidden.",
  })
  approve(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResetRequestDetailDto> {
    return this.resetRequests.decide(principal.sub, id, PasswordResetRequestStatus.APPROVED);
  }

  @Post(':id/deny')
  @HttpCode(200)
  @Throttle(DECIDE_THROTTLE)
  @UseGuards(PermissionsGuard)
  @RequirePermissions(ADMIN_RESET_PERMISSION)
  @ApiOkResponse({
    type: ResetRequestDetailDto,
    description:
      'Deny a pending reset request; the requester is notified (durable receipt). Same contract and error set as approve.',
  })
  deny(
    @CurrentUser() principal: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResetRequestDetailDto> {
    return this.resetRequests.decide(principal.sub, id, PasswordResetRequestStatus.DENIED);
  }
}

/** Parse the optional ?status= filter; an unknown value is a stable 400 (mirrors notification-list.query). */
function parseStatusFilter(raw: string | undefined): PasswordResetRequestStatus | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!(value in PasswordResetRequestStatus)) {
    throw new BadRequestException({
      code: 'Validation.Failed',
      message: `status "${value}" is not a valid reset-request status.`,
    });
  }
  return value as PasswordResetRequestStatus;
}
