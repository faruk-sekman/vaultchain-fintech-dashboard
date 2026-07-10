/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /auth/password/admin-reset. The administrator
 * fallback for an operator who cannot self-serve the MFA-gated reset. The global ValidationPipe
 * (whitelist + forbidNonWhitelisted) rejects unknown fields. `targetUserId` must be a UUID; `newPassword`
 * length is bounded here for a fast fail, with the full character-class policy (min 12) enforced
 * server-side so the stable `Auth.WeakPassword` envelope is returned. The new password is never logged —
 * the request body is never written to logs.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PWRESET_PASSWORD_MAX_LENGTH, PWRESET_PASSWORD_MIN_LENGTH } from '../password-reset.constants';

export class AdminPasswordResetDto {
  @ApiProperty({ format: 'uuid', description: 'The target operator whose password is to be reset.' })
  @IsUUID()
  targetUserId!: string;

  @ApiProperty({
    minLength: PWRESET_PASSWORD_MIN_LENGTH,
    maxLength: PWRESET_PASSWORD_MAX_LENGTH,
    description: 'The new password (min 12 chars; must include upper, lower, digit, and symbol).',
  })
  @IsString()
  @MinLength(PWRESET_PASSWORD_MIN_LENGTH)
  @MaxLength(PWRESET_PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
