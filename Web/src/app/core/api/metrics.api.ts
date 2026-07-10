/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Daily analytics metrics client. All calls go through the
 * repository API base (`environment.apiBaseUrl`) via ApiClientService; no static chart data.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from '@core/api/api-client.service';

export type DailyMetricKey =
  | 'customers_new_daily'
  | 'customers_active_total_daily'
  | 'transactions_count_daily'
  | 'transactions_volume_minor_daily';

export interface DailyMetricItem {
  date: string;
  value: string;
}

export interface DailyMetrics {
  metric: DailyMetricKey;
  items: DailyMetricItem[];
  asOf: string;
}

export interface DailyMetricsQuery {
  metric: DailyMetricKey;
  from: string;
  to: string;
}

@Injectable({ providedIn: 'root' })
export class MetricsApi {
  constructor(private readonly api: ApiClientService) {}

  getDaily(query: DailyMetricsQuery): Observable<DailyMetrics> {
    return this.api
      .get<{ data: DailyMetrics }>('/metrics/daily', {
        metric: query.metric,
        from: query.from,
        to: query.to,
      })
      .pipe(map(r => r.data));
  }
}
