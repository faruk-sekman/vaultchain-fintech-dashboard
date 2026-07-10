/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Web3/AML risk endpoints (api-endpoint-specifications §7), gated by `kyc.manage`
 * (record) / `kyc.read` (history). Persists rule-based screening decisions while keeping the
 * structural safety label. Responses are wrapped by the global envelope interceptor.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import {
  CreateRiskDecisionDto,
  PaginatedRiskAssessmentListDto,
  RiskAssessmentResponseDto,
  RiskScreeningResponseDto,
  ScreenRiskAddressDto,
} from './dto/risk.dto';
import { RiskService } from './risk.service';

/** Compliance-write throttle: 30/min/IP — stricter than the default read class (audit M10). */
const WRITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;

@ApiTags('risk')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('customers')
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Post(':id/risk-decisions')
  @Throttle(WRITE_THROTTLE)
  @RequirePermissions('kyc.manage')
  @ApiCreatedResponse({ type: RiskAssessmentResponseDto, description: 'Persist a rule-based screening decision with its safety label.' })
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRiskDecisionDto,
    @CurrentUser() actor: AuthPrincipal,
  ): Promise<RiskAssessmentResponseDto> {
    return this.risk.recordDecision(id, dto, actor);
  }

  @Post(':id/risk-screenings')
  @Throttle(WRITE_THROTTLE)
  @RequirePermissions('kyc.read')
  @HttpCode(200)
  @ApiOkResponse({ type: RiskScreeningResponseDto, description: 'Screen an address through the bound risk provider without persisting a decision.' })
  screen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScreenRiskAddressDto,
  ): Promise<RiskScreeningResponseDto> {
    return this.risk.screenAddress(id, dto.address);
  }

  @Get(':id/risk-assessments')
  @RequirePermissions('kyc.read')
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiOkResponse({ type: PaginatedRiskAssessmentListDto, description: 'Screening history, newest first; each carries its isSimulated flag.' })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedRiskAssessmentListDto> {
    return this.risk.listAssessments(id, query);
  }
}
