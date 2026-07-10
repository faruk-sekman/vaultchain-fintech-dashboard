/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { MetricsController } from './metrics.controller';
import type { AnalyticsService } from './analytics.service';

describe('MetricsController', () => {
  function setup() {
    const analytics = {
      getDailyMetrics: jest.fn().mockResolvedValue({
        metric: 'customers_new_daily',
        items: [{ date: '2026-06-07', value: '4' }],
        asOf: '2026-06-07T12:00:00.000Z',
      }),
    };
    return {
      controller: new MetricsController(analytics as unknown as AnalyticsService),
      analytics,
    };
  }

  it('parses and forwards the daily metric query', async () => {
    const { controller, analytics } = setup();
    await expect(
      controller.getDaily({
        metric: 'customers_new_daily',
        from: '2026-06-01',
        to: '2026-06-07',
      }),
    ).resolves.toEqual({
      metric: 'customers_new_daily',
      items: [{ date: '2026-06-07', value: '4' }],
      asOf: '2026-06-07T12:00:00.000Z',
    });
    expect(analytics.getDailyMetrics).toHaveBeenCalledWith({
      metric: 'customers_new_daily',
      from: '2026-06-01',
      to: '2026-06-07',
    });
  });

  it('does not call the service for invalid queries', async () => {
    const { controller, analytics } = setup();
    expect(() => controller.getDaily({ metric: 'bad', from: '2026-06-01', to: '2026-06-07' })).toThrow();
    expect(analytics.getDailyMetrics).not.toHaveBeenCalled();
  });
});
