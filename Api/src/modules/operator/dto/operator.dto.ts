/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Operator profile + notification-PREFERENCES contracts. The notification FEED DTOs moved to the real
 * notification domain (`notification/dto/notification.dto.ts`).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class OperatorProfileDto {
  @ApiProperty({ nullable: true })
  displayName!: string | null;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true })
  phone!: string | null;

  @ApiProperty({ nullable: true, description: 'Operator-entered title stored as settings state.' })
  jobTitle!: string | null;
}

export class UpdateOperatorProfileDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  displayName?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  jobTitle?: string;
}

export class NotificationPreferencesDto {
  @ApiProperty()
  productUpdates!: boolean;

  @ApiProperty()
  securityAlerts!: boolean;

  @ApiProperty()
  weeklyDigest!: boolean;
}

export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  productUpdates?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  securityAlerts?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  weeklyDigest?: boolean;
}
