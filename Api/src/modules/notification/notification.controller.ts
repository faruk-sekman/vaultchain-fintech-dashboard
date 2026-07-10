/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Operator notification endpoints under /api/v1/operator/notifications. ALL routes are
 * RECIPIENT-SCOPED to the authenticated subject (the service applies `recipientUserId = actor.sub` on
 * every query) — a user can only list/read/mark their OWN notifications; another user's id yields a 404.
 * JwtAuthGuard authenticates (normal access token); no extra permission is required — every operator
 * sees only their own feed. Responses are wrapped by the global envelope interceptor.
 */
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import {
  NotificationReadResultDto,
  PaginatedNotificationListDto,
} from './dto/notification.dto';
import { NotificationService } from './notification.service';

@ApiTags('operator')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('operator/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiQuery({ name: 'filter[type]', required: false, description: 'SECURITY_ALERT | KYC_EVENT | CUSTOMER_EVENT | SYSTEM | ACCOUNT' })
  @ApiQuery({ name: 'filter[severity]', required: false, description: 'info | success | warning | critical' })
  @ApiQuery({ name: 'filter[read]', required: false, description: 'true = read only, false = unread only.' })
  @ApiOkResponse({
    type: PaginatedNotificationListDto,
    description: "Recipient-scoped paged notifications + the recipient's total unreadCount.",
  })
  list(
    @CurrentUser() actor: AuthPrincipal,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedNotificationListDto> {
    return this.notifications.list(actor, query);
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOkResponse({
    type: NotificationReadResultDto,
    description: 'Mark ONE of the caller\'s own notifications read (404 if not owned/known). Idempotent.',
  })
  markRead(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotificationReadResultDto> {
    return this.notifications.markRead(actor, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOkResponse({
    type: NotificationReadResultDto,
    description: "Mark ALL of the caller's unread notifications read; returns unreadCount = 0.",
  })
  markAll(@CurrentUser() actor: AuthPrincipal): Promise<NotificationReadResultDto> {
    return this.notifications.markAll(actor);
  }
}
