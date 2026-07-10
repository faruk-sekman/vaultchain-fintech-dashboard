/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for POST /api/v1/transactions (api-endpoint-specifications §5). Money is
 * integer minor-units (never float). Mass-assignment is blocked by the global
 * ValidationPipe (whitelist + forbidNonWhitelisted).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransactionKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
} from 'class-validator';

export class CreateTransactionDto {
  @ApiProperty({ enum: TransactionKind })
  @IsEnum(TransactionKind)
  kind!: TransactionKind;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for WITHDRAWAL/TRANSFER.' })
  @IsOptional()
  @IsUUID()
  sourceWalletId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for DEPOSIT/TRANSFER.' })
  @IsOptional()
  @IsUUID()
  targetWalletId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required for REVERSAL — the POSTED transaction to reverse (amountMinor + currency must match it).',
  })
  @IsOptional()
  @IsUUID()
  originalTransactionId?: string;

  @ApiProperty({ description: 'Amount in integer minor units (> 0).', minimum: 1 })
  @IsInt()
  @IsPositive()
  // Upper safe-integer bound (re-audit TESTQ-002): a JSON body number above 2^53 is already lossy at
  // parse time yet passes @IsInt, and the service BigInt-converts it — reject it here instead.
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;

  @ApiProperty({ description: 'ISO-4217 code; both legs share one currency (no cross-currency).' })
  @IsString()
  @Length(3, 3)
  currency!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
