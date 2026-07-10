/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the admin-only paged user list. The picker that drives the
 * admin password-reset screen (Option 2b) needs to choose a target operator; this is a
 * deliberately PII-MINIMAL projection of the User table.
 *
 * Field allowlist (security): `id`, `displayName`, `status`, `roles[]`, a MASKED `emailMasked`, and the
 * lockout telemetry the operator-status panel needs (`locked`, `failedLoginCount`, `lastLoginAt`). NEVER
 * `passwordHash`, MFA secret, or a RAW email/phone — the email is masked server-side (`m***@s***.local`)
 * so no raw PII ever leaves the service. Exposing the masked email + lockout state is an owner-approved
 * change (the projection was previously PII-minimal): the admin password-reset screen renders an
 * operator-status panel so the admin can confirm WHO they reset and WHY (locked / failed attempts / last
 * seen) before a destructive, audited action. The id is the UUID the reset endpoint takes as `targetUserId`.
 */
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '@prisma/client';

/** Pagination metadata — same shape as the customer list `page` envelope (api-design-guidelines). */
export class UserListPageDto {
  @ApiProperty({ example: 1 }) number!: number;
  @ApiProperty({ example: 25 }) size!: number;
  @ApiProperty({ example: 3 }) totalItems!: number;
  @ApiProperty({ example: 1 }) totalPages!: number;
}

/** One row in the admin user list. PII is MASKED server-side (never raw) — see file header. */
export class UserListItemDto {
  @ApiProperty({ format: 'uuid', description: 'User id — the value used as targetUserId by admin tools.' })
  id!: string;

  @ApiProperty({ nullable: true, description: 'Operator display name (the picker label); null if unset.' })
  displayName!: string | null;

  @ApiProperty({ enum: UserStatus, description: 'Account status (e.g. ACTIVE / SUSPENDED / LOCKED).' })
  status!: UserStatus;

  @ApiProperty({ type: [String], example: ['administrator'], description: 'Role names the user holds.' })
  roles!: string[];

  @ApiProperty({
    example: 'm***@s***.local',
    description: 'Email MASKED server-side (raw address never leaves the service). For the operator picker.',
  })
  emailMasked!: string;

  @ApiProperty({
    description: 'True when the account is locked (status LOCKED or a future lockedUntil). Drives the "Kilitli" badge.',
  })
  locked!: boolean;

  @ApiProperty({ example: 5, description: 'Consecutive failed-login count (real lockout telemetry).' })
  failedLoginCount!: number;

  @ApiProperty({
    nullable: true,
    format: 'date-time',
    description: 'Last successful sign-in (ISO 8601); null if never. Rendered relative on the client.',
  })
  lastLoginAt!: string | null;
}

/** Paged `{ data, page }` envelope for the admin user list. */
export class PaginatedUserListDto {
  @ApiProperty({ type: [UserListItemDto] }) data!: UserListItemDto[];
  @ApiProperty({ type: UserListPageDto }) page!: UserListPageDto;
}
