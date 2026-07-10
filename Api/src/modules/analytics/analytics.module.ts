/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRollupScheduler } from './analytics-rollup.scheduler';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [AuthModule], // provides JwtAuthGuard + PermissionsGuard
  controllers: [AnalyticsController, MetricsController],
  providers: [AnalyticsService, AnalyticsRollupScheduler],
})
export class AnalyticsModule {}
