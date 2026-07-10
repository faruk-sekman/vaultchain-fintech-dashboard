/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response DTO for the customer's default wallet (api-endpoint-specifications §GET
 * /customers/{id}/wallet; 1:1 default wallet).
 *
 * Money wire-format (audit O-10): every integer-minor-unit money field
 * (`balanceMinor`, `availableBalanceMinor`, `dailyLimitMinor`, `monthlyLimitMinor`) crosses the
 * wire as a JSON STRING of the exact integer minor-units (e.g. "1234500"), NOT a JSON number. This
 * is lossless regardless of magnitude and frees the FE from JS `number` (IEEE-754) precision limits;
 * the FE mirrors this contract exactly. Storage/compute stays BigInt — only the serialized type is a
 * string. The service emits each via `.toString()` of the `minorToSafeNumber`-guarded value.
 */
import { ApiProperty } from '@nestjs/swagger';
import { WalletStatus } from '@prisma/client';

export class WalletDetailDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'ISO-4217 currency code.' }) currency!: string;
  @ApiProperty({ type: String, description: 'Balance in integer minor units, as a decimal string.' }) balanceMinor!: string;
  @ApiProperty({ type: String, description: 'Available balance (balance − holds), minor units, as a decimal string.' }) availableBalanceMinor!: string;
  @ApiProperty({ type: String, description: 'Daily limit, minor units, as a decimal string.' }) dailyLimitMinor!: string;
  @ApiProperty({ type: String, description: 'Monthly limit, minor units, as a decimal string.' }) monthlyLimitMinor!: string;
  @ApiProperty({ enum: WalletStatus }) status!: WalletStatus;
  @ApiProperty({ description: 'Optimistic-concurrency token for limit updates.' }) rowVersion!: number;
}
