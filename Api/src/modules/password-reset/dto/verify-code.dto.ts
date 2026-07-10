/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /auth/password/reset/verify-code. The second
 * factor — a 6-digit TOTP OR an XXXXX-XXXXX backup code (the service routes by shape) — is verified
 * ONCE here and the challenge is stamped `factor_verified_at`; the later password-only /verify carries
 * NO code. The `code` field + regex are lifted VERBATIM from the original VerifyPasswordResetDto so the
 * shape-routing is byte-for-byte unchanged. The global ValidationPipe (whitelist + forbidNonWhitelisted)
 * rejects unknown fields. The code is never logged — the request body is never written to logs.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class VerifyCodeDto {
  @ApiProperty({
    example: '123456',
    description: 'A current 6-digit TOTP code OR a one-time backup code (XXXXX-XXXXX).',
  })
  @IsString()
  @Matches(/^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/, { message: 'code must be a 6-digit TOTP or an XXXXX-XXXXX backup code' })
  code!: string;
}
