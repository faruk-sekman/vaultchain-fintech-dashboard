/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /auth/password/reset-request (A15). Identical transforms/validators to
 * InitiatePasswordResetDto: the global ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown
 * fields; the email is normalized (trim + lowercase) before it reaches the service so lookup + masking
 * are consistent. The raw email is never logged or audited — only its masked form is recorded.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';

export class CreateResetRequestDto {
  @ApiProperty({
    format: 'email',
    example: 'operator@example.com',
    description: 'The account email to request an administrator password reset for.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
