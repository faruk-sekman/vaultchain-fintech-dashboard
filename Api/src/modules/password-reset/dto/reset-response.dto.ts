/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the self-service password-reset endpoints. Both
 * carry a single stable `status` literal and NO tokens — the verify response deliberately issues no
 * access/refresh token (no auto-login), forcing a fresh /login.
 */
import { ApiProperty } from '@nestjs/swagger';

export class ResetInitiatedResponseDto {
  @ApiProperty({ enum: ['reset_initiated'], example: 'reset_initiated', description: 'Constant acknowledgement — returned for every email (no enumeration).' })
  status!: 'reset_initiated';
}

export class ResetCodeVerifiedResponseDto {
  @ApiProperty({ enum: ['code_verified'], example: 'code_verified', description: 'the second factor was verified and the challenge stamped. Proceed to set the new password via /verify. NO tokens are issued.' })
  status!: 'code_verified';
}

export class ResetCompleteResponseDto {
  @ApiProperty({ enum: ['reset_complete'], example: 'reset_complete', description: 'The password was changed and all sessions revoked. NO tokens are issued — sign in again.' })
  status!: 'reset_complete';
}
