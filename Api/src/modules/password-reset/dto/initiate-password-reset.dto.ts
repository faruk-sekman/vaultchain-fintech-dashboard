/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /auth/password/reset/initiate. The global
 * ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown fields. The email is normalized
 * (trim + lowercase) before it ever reaches the service so lookup + masking are consistent. The raw
 * email is never logged or audited — only its masked form is recorded.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class InitiatePasswordResetDto {
  @ApiProperty({ format: 'email', example: 'operator@example.com', description: 'The account email to start a reset for.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
