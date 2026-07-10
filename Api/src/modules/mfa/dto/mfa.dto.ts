/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contracts for the MFA verify endpoints.
 * The global ValidationPipe (whitelist + forbidNonWhitelisted) rejects unknown fields; codes are
 * never logged (pino redaction). Formats are validated strictly so a malformed body fails fast.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class VerifyTotpDto {
  @ApiProperty({ pattern: '^\\d{6}$', example: '123456', description: 'The 6-digit code from the authenticator app.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit number' })
  code!: string;

  @ApiProperty({
    required: false,
    default: false,
    description: 'Trust this device and skip MFA until expiry — honoured only when remember-device is enabled.',
  })
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class VerifyBackupCodeDto {
  @ApiProperty({
    pattern: '^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$',
    example: 'A1B2C-D3E4F',
    description: 'A one-time backup recovery code (case-insensitive; the hyphen is optional).',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/, { message: 'code must be in the form XXXXX-XXXXX' })
  code!: string;
}

// ---------- Enrolment — opt-in, from a full session with a password re-auth ----------

export class StartMfaSetupDto {
  @ApiProperty({ minLength: 8, maxLength: 128, description: 'The operator’s current password — re-auth for this sensitive change.' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class ConfirmMfaSetupDto {
  @ApiProperty({ pattern: '^\\d{6}$', example: '123456', description: 'The first 6-digit code from the authenticator app, proving enrolment.' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit number' })
  code!: string;
}

export class MfaSetupStartResponseDto {
  @ApiProperty({ description: 'otpauth:// URI to import into an authenticator app.' })
  otpauthUri!: string;

  @ApiProperty({ description: 'PNG data-URL of the QR encoding the otpauth URI.' })
  qrDataUrl!: string;
}

export class MfaSetupConfirmResponseDto {
  @ApiProperty({ type: [String], description: 'One-time backup recovery codes — shown ONCE; store them now.' })
  backupCodes!: string[];
}

// ---------- Management — disable / regenerate / administrator reset ----------

/** Re-auth for a sensitive MFA change: the password PLUS a current second factor (TOTP or backup code). */
export class MfaReauthDto {
  @ApiProperty({ minLength: 8, maxLength: 128, description: 'The operator’s current password.' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: '123456', description: 'A current 6-digit TOTP code OR a one-time backup code (XXXXX-XXXXX).' })
  @IsString()
  @Matches(/^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/, { message: 'code must be a 6-digit TOTP or an XXXXX-XXXXX backup code' })
  code!: string;
}

export class AdminResetMfaDto {
  @ApiProperty({ format: 'uuid', description: 'The target operator whose MFA enrolment is to be reset.' })
  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'userId must be a UUID' })
  userId!: string;
}

/** A user's remembered ("trusted") device, for the self-service list/revoke surface. */
export class RememberedDeviceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty({ description: 'Coarse network prefix bound at issue — NOT a full IP.' })
  ipPrefix!: string;
}
