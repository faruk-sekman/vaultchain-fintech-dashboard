/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for parseDailyMetricsQuery that complement
 * metrics.query.spec.ts. These pin the remaining branches in the `readString` coercion helper
 * (array-with-non-string first element, and the non-string scalar String(v) path) and the
 * blank-after-trim required-date guard.
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

const VALID = { from: '2026-06-01', to: '2026-06-02' };

describe('parseDailyMetricsQuery — coercion + guard branches', () => {
  it('treats an array whose first element is not a string as undefined (missing metric)', () => {
    // metric is [ {} ] → readString returns undefined → Query.MetricRequired.
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: [{ not: 'a string' }] as unknown as string[], ...VALID }),
      'Query.MetricRequired',
    );
  });

  it('coerces a non-string scalar metric via String(v) (then validates the value)', () => {
    // metric is the number 123 → String(123) = "123" → not a supported metric → Validation.Failed.
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 123 as unknown as string, ...VALID }),
      'Validation.Failed',
    );
  });

  it('rejects a whitespace-only from as a required-date error (blank after trim)', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '   ', to: '2026-06-02' }),
      'Query.DateRangeRequired',
    );
  });

  it('rejects a null to as a required-date error', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-06-01', to: null as unknown as string }),
      'Query.DateRangeRequired',
    );
  });

  it('accepts a single-day range (from == to) at the lower bound', () => {
    expect(
      parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026-06-01', to: '2026-06-01' }),
    ).toEqual({ metric: 'customers_new_daily', from: '2026-06-01', to: '2026-06-01' });
  });
  it('rejects a date that fails the YYYY-MM-DD regex (wrong separators)', () => {
    expectBadQuery(
      () => parseDailyMetricsQuery({ metric: 'customers_new_daily', from: '2026/06/01', to: '2026-06-02' }),
      'Validation.Failed',
    );
  });

});
