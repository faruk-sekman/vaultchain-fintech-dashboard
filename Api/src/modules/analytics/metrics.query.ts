/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Query parser for GET /api/v1/metrics/daily. The range is date-only and
 * bounded to 366 days, matching the transaction history cap without adding a qs dependency.
 */
import { BadRequestException } from '@nestjs/common';

export const DAILY_METRIC_KEYS = [
  'customers_new_daily',
  'customers_active_total_daily',
  'transactions_count_daily',
  'transactions_volume_minor_daily',
] as const;

export type DailyMetricKey = (typeof DAILY_METRIC_KEYS)[number];

export interface ParsedDailyMetricsQuery {
  metric: DailyMetricKey;
  from: string;
  to: string;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function bad(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : String(v);
}

function parseDateOnly(raw: string | undefined, field: string): { value: string; time: number } {
  const value = raw?.trim();
  if (!value) bad('Query.DateRangeRequired', `${field} is required (YYYY-MM-DD).`);
  if (!DATE_ONLY_RE.test(value)) bad('Validation.Failed', `${field} must be a valid YYYY-MM-DD date.`);

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    bad('Validation.Failed', `${field} must be a valid YYYY-MM-DD date.`);
  }
  return { value, time: date.getTime() };
}

export function parseDailyMetricsQuery(raw: Record<string, unknown>): ParsedDailyMetricsQuery {
  const metricRaw = readString(raw, 'metric')?.trim();
  if (!metricRaw) bad('Query.MetricRequired', 'metric is required.');
  if (!DAILY_METRIC_KEYS.includes(metricRaw as DailyMetricKey)) {
    bad('Validation.Failed', `metric "${metricRaw}" is not a supported daily metric.`);
  }

  const from = parseDateOnly(readString(raw, 'from'), 'from');
  const to = parseDateOnly(readString(raw, 'to'), 'to');
  if (from.time > to.time) bad('Validation.Failed', 'from must be ≤ to.');
  if ((to.time - from.time) / DAY_MS > MAX_RANGE_DAYS) {
    bad('Query.DateRangeRequired', 'The date range must not exceed 366 days.');
  }

  return { metric: metricRaw as DailyMetricKey, from: from.value, to: to.value };
}
