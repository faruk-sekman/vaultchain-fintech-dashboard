/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response DTOs for the customer read endpoints (api-endpoint-specifications §GET /customers,
 * /customers/{id}). PII fields are MASKED by default (the raw values never reach these shapes);
 * `nationalIdLast4` is display-only and the encrypted blob is never exposed.
 */
import { ApiProperty } from '@nestjs/swagger';
import { CustomerStatus, KycStatus, RiskLevel } from '@prisma/client';

export class CustomerListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Masked by default (e.g. "Ada L***"); raw only with `customers.pii.reveal` + `?reveal=true`.' }) fullName!: string;
  @ApiProperty({ description: 'Masked by default (e.g. "a***@e***.com"); raw only with `customers.pii.reveal` + `?reveal=true`.' }) email!: string;
  @ApiProperty({ nullable: true, description: 'Masked last 4 by default (e.g. "*** *** 1234"); raw only with `customers.pii.reveal` + `?reveal=true`.' }) phone!: string | null;
  @ApiProperty({ nullable: true, description: 'Masked last 4 by default (e.g. "************3456"); raw only with `customers.pii.reveal` + `?reveal=true`.' }) walletNumber!: string | null;
  @ApiProperty({ nullable: true, description: 'Last 4 of the national ID in ALL modes; the full national ID is NEVER served (no decrypt path).' }) nationalIdLast4!: string | null;
  @ApiProperty({ enum: KycStatus }) kycStatus!: KycStatus;
  @ApiProperty({ enum: RiskLevel }) riskLevel!: RiskLevel;
  @ApiProperty({ enum: CustomerStatus }) status!: CustomerStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AddressDto {
  @ApiProperty({ nullable: true, description: 'Always raw (low-identifying, retained for ops UX).' }) country!: string | null;
  @ApiProperty({ nullable: true, description: 'Masked to `null` by default; raw only with `customers.pii.reveal` + `?reveal=true`.' }) city!: string | null;
  @ApiProperty({ nullable: true, description: 'Masked to `null` by default; raw only with `customers.pii.reveal` + `?reveal=true`.' }) postalCode!: string | null;
  @ApiProperty({ nullable: true, description: 'Masked to first-char + `***` by default; raw only with `customers.pii.reveal` + `?reveal=true`.' }) line1!: string | null;
}

export class CustomerDetailDto extends CustomerListItemDto {
  @ApiProperty({ format: 'date', nullable: true }) dateOfBirth!: string | null;
  @ApiProperty({ type: AddressDto }) address!: AddressDto;
  @ApiProperty({ description: 'Commercial flag — NOT a KYC state.' }) contractSigned!: boolean;
  @ApiProperty({ description: 'Optimistic-concurrency token for updates.' }) rowVersion!: number;
}

export class PageDto {
  @ApiProperty({ example: 1 }) number!: number;
  @ApiProperty({ example: 25 }) size!: number;
  @ApiProperty({ example: 1 }) totalItems!: number;
  @ApiProperty({ example: 1 }) totalPages!: number;
}

export class PaginatedCustomerListDto {
  @ApiProperty({ type: [CustomerListItemDto] }) data!: CustomerListItemDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class KycVerificationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty({ enum: KycStatus }) status!: KycStatus;
  @ApiProperty() method!: string;
  @ApiProperty({ nullable: true }) reasonCode!: string | null;
  @ApiProperty({ nullable: true, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) decidedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class KycVerificationListDto {
  @ApiProperty({ type: [KycVerificationDto] }) items!: KycVerificationDto[];
}

export class PaginatedKycVerificationListDto {
  @ApiProperty({ type: [KycVerificationDto] }) data!: KycVerificationDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class CredentialSubjectDto {
  @ApiProperty({ description: 'Pairwise DID-like preview id scoped to this customer.' })
  id!: string;

  @ApiProperty({ description: 'Whether the customer is currently KYC verified.' })
  kycVerified!: boolean;
}

export class CredentialPreviewDto {
  @ApiProperty({ name: '@context', type: [String] })
  '@context'!: string[];

  @ApiProperty({ type: [String] })
  type!: string[];

  @ApiProperty()
  issuer!: string;

  @ApiProperty({ format: 'date-time' })
  issuanceDate!: string;

  @ApiProperty({ type: CredentialSubjectDto })
  credentialSubject!: CredentialSubjectDto;
}
