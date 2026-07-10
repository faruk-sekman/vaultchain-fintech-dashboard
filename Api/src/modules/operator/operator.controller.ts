/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Operator self-service: profile + notification PREFERENCES. The notification FEED
 * (GET /operator/notifications) moved to the real notification domain (
 * `notification/` module) — this controller no longer serves it.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import {
  NotificationPreferencesDto,
  OperatorProfileDto,
  UpdateNotificationPreferencesDto,
  UpdateOperatorProfileDto,
} from './dto/operator.dto';
import { OperatorService } from './operator.service';

@ApiTags('operator')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('operator')
export class OperatorController {
  constructor(private readonly operator: OperatorService) {}

  @Get('profile')
  @ApiOkResponse({ type: OperatorProfileDto, description: 'Authenticated operator profile/settings.' })
  getProfile(@CurrentUser() actor: AuthPrincipal): Promise<OperatorProfileDto> {
    return this.operator.getProfile(actor);
  }

  @Patch('profile')
  @ApiOkResponse({ type: OperatorProfileDto, description: 'Update authenticated operator profile/settings.' })
  updateProfile(
    @CurrentUser() actor: AuthPrincipal,
    @Body() dto: UpdateOperatorProfileDto,
  ): Promise<OperatorProfileDto> {
    return this.operator.updateProfile(actor, dto);
  }

  @Get('notification-preferences')
  @ApiOkResponse({ type: NotificationPreferencesDto, description: 'Authenticated operator notification preferences.' })
  getNotificationPreferences(@CurrentUser() actor: AuthPrincipal): Promise<NotificationPreferencesDto> {
    return this.operator.getNotificationPreferences(actor);
  }

  @Patch('notification-preferences')
  @ApiOkResponse({ type: NotificationPreferencesDto, description: 'Update authenticated operator notification preferences.' })
  updateNotificationPreferences(
    @CurrentUser() actor: AuthPrincipal,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    return this.operator.updateNotificationPreferences(actor, dto);
  }
}
