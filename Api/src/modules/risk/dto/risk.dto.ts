/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Request/response contracts for the Web3/AML risk endpoints (api-endpoint-specifications §7).
 * `isSimulated` is a mandatory honesty flag; addresses are validated at the edge.
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RiskDecision, RiskSignalSeverity } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { PageDto } from '../../customers/dto/customer.dto';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class RiskSignalDto {
  @ApiProperty({ description: 'Signal key, e.g. sanctionsHit.' })
  @IsString()
  @Length(1, 64)
  key!: string;

  @ApiProperty()
  @IsBoolean()
  hit!: boolean;

  @ApiProperty({ enum: RiskSignalSeverity })
  @IsEnum(RiskSignalSeverity)
  severity!: RiskSignalSeverity;
}

export class CreateRiskDecisionDto {
  @ApiProperty({ description: 'On-chain address (0x + 40 hex).' })
  @Matches(ADDRESS_RE, { message: 'address must match ^0x[0-9a-fA-F]{40}$' })
  address!: string;

  @ApiProperty({ enum: RiskDecision })
  @IsEnum(RiskDecision)
  decision!: RiskDecision;

  @ApiProperty({ description: 'Safety flag — must be true while the rule-based engine is bound.' })
  @IsBoolean()
  isSimulated!: boolean;

  @ApiPropertyOptional({ type: [RiskSignalDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RiskSignalDto)
  signals?: RiskSignalDto[];
}

export class ScreenRiskAddressDto {
  @ApiProperty({ description: 'On-chain address (0x + 40 hex).' })
  @Matches(ADDRESS_RE, { message: 'address must match ^0x[0-9a-fA-F]{40}$' })
  address!: string;
}

export class RiskAssessmentResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  customerId!: string;

  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: RiskDecision })
  decision!: RiskDecision;

  @ApiProperty({ description: 'True for rule-based screening (never a live vendor regulatory decision).' })
  isSimulated!: boolean;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: [RiskSignalDto] })
  signals!: RiskSignalDto[];
}

export class PaginatedRiskAssessmentListDto {
  @ApiProperty({ type: [RiskAssessmentResponseDto] })
  data!: RiskAssessmentResponseDto[];

  @ApiProperty({ type: PageDto })
  page!: PageDto;
}

export class RiskScreeningResponseDto {
  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: RiskDecision })
  decision!: RiskDecision;

  @ApiProperty({ description: 'True for rule-based screening (never a live vendor regulatory decision).' })
  isSimulated!: boolean;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({ type: [RiskSignalDto] })
  signals!: RiskSignalDto[];
}
