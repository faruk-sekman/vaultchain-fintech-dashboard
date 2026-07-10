/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /auth/password/reset/verify (refactored to be
 * password-ONLY). The second factor is proven EARLIER at
 * POST /auth/password/reset/verify-code (which stamps `factor_verified_at` on the challenge), so this
 * call carries NO code — only the new password. `newPassword` length is bounded here for a fast fail;
 * the full character-class policy (min 12) is enforced server-side in the service so the stable
 * `Auth.WeakPassword` envelope is returned. The password is never logged — the request body is never
 * written to logs. The global ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown fields,
 * so a stale `{ code, newPassword }` client is rejected (400) rather than silently accepted.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PWRESET_PASSWORD_MAX_LENGTH, PWRESET_PASSWORD_MIN_LENGTH } from '../password-reset.constants';

export class VerifyPasswordResetDto {
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
