/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * GET /api/v1/metrics/daily — read-only daily analytics series. Responses are
 * wrapped globally as { data, meta:{ correlationId } }.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { AnalyticsService } from './analytics.service';
import { DailyMetricsDto } from './dto/metrics.dto';
import { DAILY_METRIC_KEYS, parseDailyMetricsQuery } from './metrics.query';

@ApiTags('metrics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('customers.read')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('daily')
  @ApiQuery({ name: 'metric', required: true, enum: DAILY_METRIC_KEYS })
  @ApiQuery({ name: 'from', required: true, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'to', required: true, schema: { type: 'string', format: 'date' } })
  @ApiOkResponse({ type: DailyMetricsDto, description: 'Daily rollup series for the selected metric.' })
  getDaily(@Query() query: Record<string, unknown>): Promise<DailyMetricsDto> {
    return this.analytics.getDailyMetrics(parseDailyMetricsQuery(query));
  }
}
