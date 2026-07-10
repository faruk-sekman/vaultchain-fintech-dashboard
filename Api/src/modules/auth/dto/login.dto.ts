/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /api/v1/auth/login. The global ValidationPipe (whitelist +
 * forbidNonWhitelisted) rejects unknown fields; the password is never logged (pino redaction).
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
