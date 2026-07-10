/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response contracts for the dashboard aggregates (api-endpoint-specifications §6). These are the
 * named OpenAPI schemas (DashboardSummary, AgeStats, KycDistribution[Item], LatestCustomer). All
 * KPIs are server-computed over ALL customers — never the old browser-side ≤60-record slice.
 */
import { ApiProperty } from '@nestjs/swagger';
import { CustomerStatus, KycStatus, RiskLevel } from '@prisma/client';

export class AgeStatsDto {
  @ApiProperty({ nullable: true, description: 'Whole years; null when no dated births.' })
  avg!: number | null;

  @ApiProperty({ nullable: true })
  min!: number | null;

  @ApiProperty({ nullable: true })
  max!: number | null;
}

export class DashboardSummaryDto {
  @ApiProperty({ description: 'Total customers — not page-size limited.' })
  totalCustomers!: number;

  @ApiProperty()
  activeCount!: number;

  @ApiProperty()
  inactiveCount!: number;

  @ApiProperty({ description: 'Percent (one decimal), server-computed.' })
  activeRate!: number;

  @ApiProperty({ description: 'Percent (one decimal), server-computed.' })
  inactiveRate!: number;

  @ApiProperty({ type: AgeStatsDto, nullable: true })
  ageStats!: AgeStatsDto | null;

  @ApiProperty({ format: 'date-time', description: 'Freshness stamp (≤5 min target).' })
  asOf!: string;
}

export class KycDistributionItemDto {
  @ApiProperty({ enum: KycStatus })
  status!: KycStatus;

  @ApiProperty()
  count!: number;

  @ApiProperty({ description: 'Percent of total (one decimal).' })
  percent!: number;
}

export class KycDistributionDto {
  @ApiProperty({ type: [KycDistributionItemDto], description: 'Every enum value present (0 allowed).' })
  items!: KycDistributionItemDto[];

  @ApiProperty({ description: 'Equals DashboardSummary.totalCustomers.' })
  total!: number;

  @ApiProperty({ format: 'date-time' })
  asOf!: string;
}

/** Customer card with PII masked at the source (mask.ts) — no raw email/phone/DOB/national id. */
export class MaskedCustomerDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Masked, e.g. Ada L***' })
  fullName!: string;

  @ApiProperty({ description: 'Masked, e.g. j***@e***.com' })
  email!: string;

  @ApiProperty({ nullable: true, description: 'Masked, last four digits only.' })
  phone!: string | null;

  @ApiProperty({ enum: KycStatus })
  kycStatus!: KycStatus;

  @ApiProperty({ enum: CustomerStatus })
  status!: CustomerStatus;

  @ApiProperty({ enum: RiskLevel })
  riskLevel!: RiskLevel;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WalletSummaryDto {
  @ApiProperty({ description: 'ISO-4217 code.' })
  currency!: string;

  @ApiProperty({ type: String, description: 'Integer minor units, as a decimal string.' })
  balanceMinor!: string;
}

export class LatestCustomerDto {
  @ApiProperty({ type: MaskedCustomerDto })
  customer!: MaskedCustomerDto;

  @ApiProperty({ type: WalletSummaryDto, nullable: true })
  wallet!: WalletSummaryDto | null;
}
