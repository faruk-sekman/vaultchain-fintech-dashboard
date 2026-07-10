/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * GET /api/v1/dashboard/* — server-side aggregates that replace the browser-side ≤60-record
 * computation (api-endpoint-specifications §6). Responses are wrapped by the global envelope
 * interceptor as { data, meta:{ correlationId } }; handlers return the bare payload.
 *
 * Gated by `customers.read`: JwtAuthGuard authenticates, PermissionsGuard authorizes
 * requests. This closed the unauthenticated-PII exposure appsec flagged during the dashboard work.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AnalyticsService } from './analytics.service';
import {
  DashboardSummaryDto,
  KycDistributionDto,
  LatestCustomerDto,
  MaskedCustomerDto,
} from './dto/dashboard.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('customers.read')
@Controller('dashboard')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiOkResponse({ type: DashboardSummaryDto, description: 'Top-line KPIs over all customers.' })
  getSummary(): Promise<DashboardSummaryDto> {
    return this.analytics.getSummary();
  }

  @Get('kyc-distribution')
  @ApiOkResponse({ type: KycDistributionDto, description: 'KYC status distribution (zero-filled).' })
  getKycDistribution(): Promise<KycDistributionDto> {
    return this.analytics.getKycDistribution();
  }

  @Get('latest-customer')
  @ApiOkResponse({
    type: LatestCustomerDto,
    description: 'Most-recently-updated customer (PII masked); data is null when none exist.',
  })
  async getLatestCustomer(): Promise<LatestCustomerDto | null> {
    // Envelope-consistent "empty": 200 with `data: null` when there are no customers (the global
    // interceptor wraps every response, which a bodyless 204 would fight).
    return (await this.analytics.getLatestCustomer()) ?? null;
  }

  @Get('recent-customers')
  @ApiQuery({ name: 'limit', required: false, description: 'How many to return (1..10, default 3).' })
  @ApiOkResponse({
    type: [MaskedCustomerDto],
    description: 'The most-recently-updated customers (PII masked), newest first.',
  })
  getRecentCustomers(@Query('limit') limit?: string): Promise<MaskedCustomerDto[]> {
    return this.analytics.getRecentCustomers(limit === undefined ? 3 : Number(limit));
  }
}
