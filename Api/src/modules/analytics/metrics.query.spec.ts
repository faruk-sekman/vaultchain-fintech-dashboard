/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { BadRequestException } from '@nestjs/common';
import { parseDailyMetricsQuery } from './metrics.query';

function expectBadQuery(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('Expected parser to throw.');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
  }
}

describe('parseDailyMetricsQuery', () => {
  it('accepts a supported metric and date-only range', () => {
    expect(
      parseDailyMetricsQuery({
        metric: 'customers_new_daily',
        from: '2026-06-01',
        to: '2026-06-07',
      }),
    ).toEqual({
      metric: 'customers_new_daily',
      from: '2026-06-01',
      to: '2026-06-07',
    });
  });

  it('uses the first string when Fastify supplies an array-like query value', () => {
    expect(
      parseDailyMetricsQuery({
        metric: ['transactions_count_daily'],
        from: ['2026-06-01'],
        to: ['2026-06-02'],
      }),
    ).toEqual({
      metric: 'transactions_count_daily',
      from: '2026-06-01',
      to: '2026-06-02',
    });
  });

  it('requires metric', () => {
    expectBadQuery(() => parseDailyMetricsQuery({ from: '2026-06-01', to: '2026-06-02' }), 'Query.MetricRequired');
  });

  it('rejects unsupported metrics', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers.total', from: '2026-06-01', to: '2026-06-02' }),
      'Validation.Failed',
    );
  });

  it('rejects invalid date-only values', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-02-31', to: '2026-06-02' }),
      'Validation.Failed',
    );
  });

  it('requires both range endpoints', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-06-01' }),
      'Query.DateRangeRequired',
    );
  });

  it('rejects inverted ranges', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-06-08', to: '2026-06-07' }),
      'Validation.Failed',
    );
  });

  it('caps ranges at 366 days', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-01-01', to: '2027-01-03' }),
      'Query.DateRangeRequired',
    );
  });
});
