/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request contract for PATCH /customers/:id/wallet. Limits are accepted in MAJOR
 * units (e.g. 5000 = ₺5000) to match the frontend's display units; the service converts to the
 * integer minor units stored on the wallet. The response is the standard `WalletDetailDto` (minor).
 * `rowVersion` is the optimistic-concurrency token from the last wallet read; a mismatch → 409.
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, Min } from 'class-validator';

export class UpdateWalletLimitsDto {
  @ApiProperty({ description: 'Daily limit in MAJOR units (must be < monthlyLimit).', minimum: 0 })
  @IsNumber()
  @Min(0)
  dailyLimit!: number;

  @ApiProperty({ description: 'Monthly limit in MAJOR units (must be > dailyLimit).', minimum: 0 })
  @IsNumber()
  @Min(0)
  monthlyLimit!: number;

  @ApiProperty({ description: 'Optimistic-concurrency token from the last read; mismatch → 409.' })
  @IsInt()
  @Min(0)
  rowVersion!: number;
}
