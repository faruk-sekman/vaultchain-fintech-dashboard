/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { ApiProperty } from '@nestjs/swagger';
import { DAILY_METRIC_KEYS, DailyMetricKey } from '../metrics.query';

export class DailyMetricItemDto {
  @ApiProperty({ format: 'date', example: '2026-06-07' })
  date!: string;

  @ApiProperty({
    description:
      'Numeric value serialized as a string to preserve bigint/numeric precision for counts and minor-unit volume.',
    example: '125000',
  })
  value!: string;
}

export class DailyMetricsDto {
  @ApiProperty({ enum: DAILY_METRIC_KEYS })
  metric!: DailyMetricKey;

  @ApiProperty({
    type: [DailyMetricItemDto],
    description:
      'One row per rolled-up day. Currency-dimensioned volume rows are summed per day for this read model.',
  })
  items!: DailyMetricItemDto[];

  @ApiProperty({ format: 'date-time', description: 'Freshness stamp from metric_daily.updated_at.' })
  asOf!: string;
}
