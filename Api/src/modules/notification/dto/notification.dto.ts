/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the operator notification feed. The list is paged with a
 * `{ data, page, unreadCount }` envelope (unreadCount is the recipient's TOTAL unread, independent of
 * the current page/filter — it drives the FE badge). Bodies carry i18n KEYS (titleKey/bodyKey) +
 * allowlisted, non-PII `params` the FE interpolates; the BE owns no copy. No PII/secret is ever
 * returned (the emit-layer params guard enforces that on the way in).
 */
import { ApiProperty } from '@nestjs/swagger';
import { NotificationSeverity, NotificationType } from '@prisma/client';

/** Pagination metadata — same shape as the customer list `page` envelope. */
export class NotificationPageDto {
  @ApiProperty({ example: 1 }) number!: number;
  @ApiProperty({ example: 20 }) size!: number;
  @ApiProperty({ example: 7 }) totalItems!: number;
  @ApiProperty({ example: 1 }) totalPages!: number;
}

/** One notification row (recipient-private; rendered by the FE from the i18n keys + params). */
export class NotificationItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: NotificationType }) type!: NotificationType;
  @ApiProperty({ enum: NotificationSeverity }) severity!: NotificationSeverity;
  @ApiProperty({ example: 'notifications.security.adminPasswordReset.title' }) titleKey!: string;
  @ApiProperty({ example: 'notifications.security.adminPasswordReset.body' }) bodyKey!: string;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Allowlisted, non-PII interpolation values for the FE; null when none.',
  })
  params!: Record<string, unknown> | null;
  @ApiProperty({ example: 'user' }) resourceType!: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) resourceId!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time', description: 'null = unread.' }) readAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** Paged `{ data, page, unreadCount }` envelope for GET /operator/notifications. */
export class PaginatedNotificationListDto {
  @ApiProperty({ type: [NotificationItemDto] }) data!: NotificationItemDto[];
  @ApiProperty({ type: NotificationPageDto }) page!: NotificationPageDto;
  @ApiProperty({ example: 3, description: "Recipient's TOTAL unread count (independent of page/filter)." })
  unreadCount!: number;
}

/** Result of a mark-read / mark-all action: the (new) total unread count for the live badge. */
export class NotificationReadResultDto {
  @ApiProperty({ example: 2, description: "Recipient's unread count AFTER the operation." })
  unreadCount!: number;
}
