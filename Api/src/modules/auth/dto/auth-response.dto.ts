/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the auth endpoints (api-endpoint-specifications §auth). The token payload
 * never includes the password hash; `permissions` are the principal's effective permission codes.
 * The refresh token is NOT in the body — it rides in an httpOnly cookie
 * (`ftd_refresh`) so XSS cannot read it; the server keeps only a hash.
 */
import { ApiProperty } from '@nestjs/swagger';

export class MeUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  displayName!: string | null;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ description: 'Whether this operator has opt-in MFA enabled (drives the Settings MFA card).' })
  mfaEnabled!: boolean;

  @ApiProperty({
    nullable: true,
    format: 'date-time',
    description:
      'ISO timestamp of the most recent successful sign-in (stamped at login), or null before the first one. Drives the Settings "last sign-in" readout.',
  })
  lastLoginAt!: string | null;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'Short-lived JWT access token (15 min).' })
  accessToken!: string;

  @ApiProperty({ default: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ description: 'Access-token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({ type: [String], description: 'Effective permission codes.' })
  permissions!: string[];

  @ApiProperty({ type: MeUserDto })
  user!: MeUserDto;
}

/** Discriminated login result: a completed session. Superset of LoginResponseDto so the
 *  existing client read path is unaffected for non-MFA (opt-in default) operators. */
export class AuthenticatedResponseDto extends LoginResponseDto {
  @ApiProperty({ enum: ['authenticated'], default: 'authenticated', description: 'Login completed — a session was issued.' })
  status!: 'authenticated';
}

/** Discriminated login result: a second factor is required; NO tokens are issued and the
 *  opaque challenge rides the httpOnly `ftd_mfa` cookie. Complete it at POST /auth/mfa/verify. */
export class MfaRequiredResponseDto {
  @ApiProperty({ enum: ['mfa_required'], default: 'mfa_required', description: 'A second factor is required.' })
  status!: 'mfa_required';
}

export class MeResponseDto {
  @ApiProperty({ type: MeUserDto })
  user!: MeUserDto;

  @ApiProperty({ type: [String] })
  permissions!: string[];
}
