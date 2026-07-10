/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the A15 admin-approval reset-request endpoints. The PUBLIC responses carry a
 * single stable `status` literal and NOTHING account-derived: the create acknowledgement is ONE neutral
 * message for every branch (created / duplicate / cooldown / unknown email — A16 enumeration posture),
 * and the status response exposes owner-only truth solely through the unguessable `ftd_pwreq` cookie.
 * The ADMIN DTOs expose masked account data ONLY (emails always via maskEmail; raw IP never present —
 * a coarse `ipPrefix` at most). No token/secret field exists on any of these DTOs.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PasswordResetRequestStatus } from '@prisma/client';

export class ResetRequestReceivedResponseDto {
  @ApiProperty({
    enum: ['reset_request_received'],
    example: 'reset_request_received',
    description:
      'Constant acknowledgement — returned for EVERY create call (new, duplicate, cooldown, or unknown email alike; no enumeration).',
  })
  status!: 'reset_request_received';
}

/** Owner-facing polling states. `pending` doubles as the fail-closed answer for any unknown/decoy token. */
export const RESET_REQUEST_POLL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type ResetRequestPollStatus = (typeof RESET_REQUEST_POLL_STATUSES)[number];

export class ResetRequestStatusResponseDto {
  @ApiProperty({
    enum: RESET_REQUEST_POLL_STATUSES,
    example: 'pending',
    description:
      "The caller's own request state, keyed by the httpOnly ftd_pwreq cookie. NEVER 401/404 — a missing/unknown/decoy token reads as 'pending' (indistinguishable). On 'approved' (not yet completed) the response ALSO sets the ftd_pwreset challenge cookie so the standard /auth/password/reset/verify step can finish the reset.",
  })
  status!: ResetRequestPollStatus;
}

export class ResetRequestAccountDto {
  @ApiProperty({ nullable: true, type: String, description: "The requesting account's display name." })
  displayName!: string | null;

  @ApiProperty({ example: 'o***@e***.com', description: 'The requesting account email — ALWAYS masked.' })
  emailMasked!: string;
}

export class ResetRequestItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: ResetRequestAccountDto })
  account!: ResetRequestAccountDto;

  @ApiProperty({ enum: PasswordResetRequestStatus, enumName: 'PasswordResetRequestStatus' })
  status!: PasswordResetRequestStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'When the request lapses (covers pending AND approved-unclaimed).' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  decidedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Display name of the deciding administrator (masked email fallback).' })
  decidedByName!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String, description: 'Stamped when the granted set-password challenge was consumed.' })
  completedAt!: string | null;
}

export class ResetRequestDetailDto extends ResetRequestItemDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: '203.0.113.0/24',
    description: 'Coarse network prefix bound at request time — the raw IP is never stored or shown.',
  })
  ipPrefix!: string | null;

  @ApiProperty({ example: 'Chrome on macOS', description: 'Coarse device summary parsed from the stored User-Agent at read time.' })
  deviceSummary!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The raw User-Agent as presented (service-truncated to 400 chars).' })
  userAgent!: string | null;
}
