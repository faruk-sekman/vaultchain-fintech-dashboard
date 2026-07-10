/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contracts for the customer write endpoints (api-endpoint-specifications
 * §POST/PUT/DELETE /customers). The global ValidationPipe (whitelist + forbidNonWhitelisted)
 * rejects unknown fields (mass-assignment defense). The national ID is accepted in full ONLY here,
 * validated, then column-encrypted by the service — it is never read back or returned.
 */
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CustomerStatus, KycStatus } from '@prisma/client';
import { IsTurkishNationalId } from '../../../common/validation/is-turkish-national-id';

export class AddressInputDto {
  @ApiProperty({ required: false, nullable: true, maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  country?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 12 })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  postalCode?: string;

  @ApiProperty({ required: false, nullable: true, maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  line1?: string;
}

export class CreateCustomerDto {
  @ApiProperty({ minLength: 3, maxLength: 100 })
  @IsString()
  @Length(3, 100)
  fullName!: string;

  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: false, nullable: true, pattern: '^\\+?\\d{7,15}$', description: 'Digits (7-15), optional leading +; separators (spaces/dashes/parentheses) are normalized away.' })
  @IsOptional()
  @IsString()
  // B7 (bugfix-backlog-2026-07): normalize-then-validate, mirroring the FE rule — separators are
  // stripped, then the canonical shape is enforced, so letters ("abc123") 400 while the legacy
  // "+90 555 ..." demo format stays accepted (and is persisted canonicalized).
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s().-]/g, '') : value))
  @Matches(/^(\+?\d{7,15})?$/, { message: 'phone must contain only digits (7-15), with an optional leading +' })
  phone?: string;

  @ApiProperty({ description: 'Turkish national ID (TC Kimlik No). Stored column-encrypted; only the last 4 are ever returned.' })
  @IsTurkishNationalId()
  nationalId!: string;

  @ApiProperty({ required: false, nullable: true, format: 'date', example: '1990-01-04' })
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @ApiProperty({ required: false, type: AddressInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address?: AddressInputDto;
}

export class UpdateCustomerDto {
  // Identity/contact fields are OPTIONAL on update: the detail read masks them, so the form sends
  // each only when the operator actually changed it. An omitted field preserves the stored value
  // (this is what lets "edit one field" work without the masked PII round-tripping back).
  @ApiProperty({ required: false, minLength: 3, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(3, 100)
  fullName?: string;

  @ApiProperty({ required: false, format: 'email' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, nullable: true, pattern: '^\\+?\\d{7,15}$', description: 'Digits (7-15), optional leading +; separators (spaces/dashes/parentheses) are normalized away.' })
  @IsOptional()
  @IsString()
  // B7 (bugfix-backlog-2026-07): normalize-then-validate, mirroring the FE rule — separators are
  // stripped, then the canonical shape is enforced, so letters ("abc123") 400 while the legacy
  // "+90 555 ..." demo format stays accepted (and is persisted canonicalized).
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s().-]/g, '') : value))
  @Matches(/^(\+?\d{7,15})?$/, { message: 'phone must contain only digits (7-15), with an optional leading +' })
  phone?: string;

  @ApiProperty({ required: false, nullable: true, format: 'date' })
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @ApiProperty({ required: false, type: AddressInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressInputDto)
  address?: AddressInputDto;

  @ApiProperty({ required: false, enum: KycStatus })
  @IsOptional()
  @IsEnum(KycStatus)
  kycStatus?: KycStatus;

  @ApiProperty({ required: false, enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiProperty({ required: false, description: 'Commercial flag — NOT a KYC state.' })
  @IsOptional()
  @IsBoolean()
  contractSigned?: boolean;

  @ApiProperty({ description: 'Optimistic-concurrency token from the last read; mismatch → 409.' })
  @IsInt()
  @Min(0)
  rowVersion!: number;
}
