/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Server-side dashboard aggregates. Retires the browser-side KPI
 * computation that fetched only pageSize:60 customers — so every KPI was wrong above 60. KPIs are
 * computed over ALL customers, with an honest `asOf`.
 *
 * Read path: the summary + KYC-distribution endpoints query the
 * `customers` base table LIVE (`asOf = now()`) instead of the materialized views, so the dashboard
 * is current and consistent with the customer list (which already counts live). A creation or
 * soft-delete is reflected on the next request with no refresh step. The MV DDL + the
 * `refreshMaterializedViews()` method are intentionally kept as harmless no-ops (out of the read
 * path) and may be retired later. The aggregates mirror the MV SELECTs exactly, so the response
 * shape and the integer/age math are unchanged — only the data source and `asOf` differ.
 *
 * The daily time-series rollup (metric_daily) is unaffected: it stays a plain callable method (no
 * scheduler dependency) that an external cron — or the integration suite — drives directly.
 */
import { Injectable } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import { maskEmail, maskName, maskPhone } from '../../common/util/mask';
import { minorToWireString } from '../../common/util/money';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MV_CUSTOMER_SUMMARY, MV_KYC_DISTRIBUTION } from './analytics.ddl';
import {
  DashboardSummaryDto,
  KycDistributionDto,
  KycDistributionItemDto,
  LatestCustomerDto,
  MaskedCustomerDto,
} from './dto/dashboard.dto';
import { DailyMetricsDto } from './dto/metrics.dto';
import { ParsedDailyMetricsQuery } from './metrics.query';

interface SummaryRow {
  total_customers: number;
  active_count: number;
  inactive_count: number;
  age_avg: number | null;
  age_min: number | null;
  age_max: number | null;
  as_of: Date;
}

interface KycRow {
  status: string;
  count: number;
  as_of: Date;
}

interface DailyMetricRow {
  date: string | Date;
  value: string;
  as_of: Date | null;
}

interface DailyRollupRow {
  legacy_total: number;
  legacy_active: number;
  customers_new_daily: number;
  customers_active_total_daily: number;
  transactions_count_daily: number;
}

interface CurrencyVolumeRow {
  currency: string;
  value: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Top-line KPIs over all live customers, computed LIVE from the `customers` base table
   * rather than the materialized view. No GROUP BY ⇒ exactly one
   * row always (even at zero customers), so `row[0]` is safe. Column list + integer/age math mirror
   * MV_CUSTOMER_SUMMARY exactly; only the source and a live `as_of = now()` differ.
   */
  async getSummary(): Promise<DashboardSummaryDto> {
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        count(*)::int                                   AS total_customers,
        count(*) FILTER (WHERE status = 'ACTIVE')::int  AS active_count,
        count(*) FILTER (WHERE status <> 'ACTIVE')::int AS inactive_count,
        round(avg(date_part('year', age(date_of_birth)))::numeric, 0)::int AS age_avg,
        min(date_part('year', age(date_of_birth)))::int AS age_min,
        max(date_part('year', age(date_of_birth)))::int AS age_max,
        now()                                           AS as_of
      FROM customers
      WHERE deleted_at IS NULL`;
    const ageStats =
      row.age_avg === null && row.age_min === null && row.age_max === null
        ? null
        : { avg: row.age_avg, min: row.age_min, max: row.age_max };
    return {
      totalCustomers: row.total_customers,
      activeCount: row.active_count,
      inactiveCount: row.inactive_count,
      activeRate: percent(row.active_count, row.total_customers),
      inactiveRate: percent(row.inactive_count, row.total_customers),
      ageStats,
      asOf: row.as_of.toISOString(),
    };
  }

  /**
   * KYC distribution over all live customers, computed LIVE from the `customers` base table
   * rather than the materialized view, zero-filled across every
   * enum value so the chart shape is stable. The query emits only statuses that occur (mirrors
   * MV_KYC_DISTRIBUTION); the service zero-fills the rest. `as_of = now()`.
   */
  async getKycDistribution(): Promise<KycDistributionDto> {
    const rows = await this.prisma.$queryRaw<KycRow[]>`
      SELECT kyc_status::text AS status, count(*)::int AS count, now() AS as_of
      FROM customers
      WHERE deleted_at IS NULL
      GROUP BY kyc_status`;
    const countByStatus = new Map(rows.map((r) => [r.status, r.count]));
    const total = rows.reduce((sum, r) => sum + r.count, 0);

    const items: KycDistributionItemDto[] = Object.values(KycStatus).map((status) => {
      const count = countByStatus.get(status) ?? 0;
      return { status, count, percent: percent(count, total) };
    });

    // Zero customers ⇒ no GROUP BY rows ⇒ no as_of of its own; use a live now() stamp.
    const asOf = rows.length > 0 ? rows[0].as_of : await this.summaryAsOf();
    return { items, total, asOf: asOf.toISOString() };
  }

  /** Most-recently-updated customer + a wallet summary, PII masked. Null when there are none. */
  async getLatestCustomer(): Promise<LatestCustomerDto | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
    if (!customer) return null;

    const wallet = await this.prisma.wallet.findFirst({
      where: { isSystem: false, account: { customerId: customer.id } },
      include: { balance: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      customer: {
        id: customer.id,
        fullName: maskName(customer.fullName),
        email: maskEmail(customer.email),
        phone: maskPhone(customer.phone),
        kycStatus: customer.kycStatus,
        status: customer.status,
        riskLevel: customer.riskLevel,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      },
      wallet: wallet
        ? { currency: wallet.currency, balanceMinor: minorToWireString(wallet.balance?.balanceMinor ?? 0n, 'balanceMinor') }
        : null,
    };
  }

  /**
   * The N most-recently-updated customers (PII masked), newest first — powers the dashboard
   * "recent customers" list. `limit` is clamped to 1..10. A just-created customer sorts to the top
   * (createdAt == updatedAt on insert), so a creation surfaces here immediately on the next fetch.
   */
  async getRecentCustomers(limit: number): Promise<MaskedCustomerDto[]> {
    const take = Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit : 3) || 3, 1), 10);
    const customers = await this.prisma.customer.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    return customers.map((customer) => ({
      id: customer.id,
      fullName: maskName(customer.fullName),
      email: maskEmail(customer.email),
      phone: maskPhone(customer.phone),
      kycStatus: customer.kycStatus,
      status: customer.status,
      riskLevel: customer.riskLevel,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
    }));
  }

  /** Daily chart series read model. Dimension rows are summed so the FE gets one value per day. */
  async getDailyMetrics(q: ParsedDailyMetricsQuery): Promise<DailyMetricsDto> {
    const rows = await this.prisma.$queryRaw<DailyMetricRow[]>`
      SELECT bucket_date::text AS date,
             COALESCE(sum(value_numeric), 0)::text AS value,
             max(updated_at) AS as_of
      FROM metric_daily
      WHERE metric_key = ${q.metric}
        AND bucket_date >= ${q.from}::date
        AND bucket_date <= ${q.to}::date
      GROUP BY bucket_date
      ORDER BY bucket_date ASC`;
    const rangeAsOf = rows.reduce<Date | null>((latest, row) => maxDate(latest, row.as_of), null);
    const metricAsOf = rangeAsOf ?? (await this.metricAsOf(q.metric)) ?? new Date();

    return {
      metric: q.metric,
      items: rows.map((row) => ({ date: dateOnly(row.date), value: row.value })),
      asOf: metricAsOf.toISOString(),
    };
  }

  /**
   * No-op retained for compatibility: the dashboard read path is
   * now LIVE off the base table, so refreshing the materialized views no longer affects what
   * clients read. Kept callable (and the MV DDL kept created) so the integration suite and any
   * external 5-min cron remain valid until the views are formally retired. Each view has the UNIQUE
   * index that REFRESH ... CONCURRENTLY requires; runs outside a transaction.
   */
  async refreshMaterializedViews(): Promise<void> {
    await this.prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV_CUSTOMER_SUMMARY}`);
    await this.prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${MV_KYC_DISTRIBUTION}`);
  }

  /**
   * Daily time-series rollup. Computed from base tables (independent of the matview refresh) and
   * written idempotently: scalar metrics use ON CONFLICT, dimensioned volume rows are replaced for
   * the bucket so stale currency dimensions cannot survive a re-run. `bucketDate` (YYYY-MM-DD)
   * defaults to the UTC database date to avoid app-clock and session-timezone drift.
   */
  async rollupDailyMetrics(bucketDate?: string): Promise<void> {
    const [row] = await this.prisma.$queryRaw<DailyRollupRow[]>`
      WITH bounds AS (
        SELECT COALESCE(${bucketDate ?? null}::date, (now() AT TIME ZONE 'UTC')::date) AS bucket_date
      ),
      utc_bounds AS (
        SELECT bucket_date,
               (bucket_date::timestamp AT TIME ZONE 'UTC') AS starts_at,
               ((bucket_date + 1)::timestamp AT TIME ZONE 'UTC') AS ends_at
        FROM bounds
      )
      SELECT
        (SELECT count(*)::int
         FROM customers c
         WHERE c.deleted_at IS NULL) AS legacy_total,
        (SELECT count(*)::int
         FROM customers c
         WHERE c.deleted_at IS NULL AND c.status = 'ACTIVE') AS legacy_active,
        (SELECT count(*)::int
         FROM customers c, utc_bounds b
         WHERE c.deleted_at IS NULL
           AND c.created_at >= b.starts_at
           AND c.created_at < b.ends_at) AS customers_new_daily,
        (SELECT count(*)::int
         FROM customers c
         WHERE c.deleted_at IS NULL AND c.status = 'ACTIVE') AS customers_active_total_daily,
        (SELECT count(*)::int
         FROM transactions tx, utc_bounds b
         WHERE tx.status = 'POSTED'
           AND tx.occurred_at >= b.starts_at
           AND tx.occurred_at < b.ends_at) AS transactions_count_daily`;
    const volumeRows = await this.prisma.$queryRaw<CurrencyVolumeRow[]>`
      WITH bounds AS (
        SELECT COALESCE(${bucketDate ?? null}::date, (now() AT TIME ZONE 'UTC')::date) AS bucket_date
      ),
      utc_bounds AS (
        SELECT bucket_date,
               (bucket_date::timestamp AT TIME ZONE 'UTC') AS starts_at,
               ((bucket_date + 1)::timestamp AT TIME ZONE 'UTC') AS ends_at
        FROM bounds
      )
      SELECT le.currency, sum(le.amount_minor)::text AS value
      FROM transactions tx
      JOIN ledger_entries le ON le.transaction_id = tx.id
      CROSS JOIN utc_bounds b
      WHERE tx.status = 'POSTED'
        AND tx.occurred_at >= b.starts_at
        AND tx.occurred_at < b.ends_at
        AND le.leg = 'DEBIT'
        -- Exclude REVERSAL: its mirror DEBIT leg would inflate gross daily volume for a net-zero
        -- correction (a deposit + its reversal both counting) (re-audit DATA-006). Every normal
        -- 2-leg transaction still counts once via its single DEBIT leg.
        AND tx.kind <> 'REVERSAL'
      GROUP BY le.currency
      ORDER BY le.currency`;

    await this.upsertDailyMetric('customers.total', row.legacy_total, bucketDate);
    await this.upsertDailyMetric('customers.active', row.legacy_active, bucketDate);
    await this.upsertDailyMetric('customers_new_daily', row.customers_new_daily, bucketDate);
    await this.upsertDailyMetric('customers_active_total_daily', row.customers_active_total_daily, bucketDate);
    await this.upsertDailyMetric('transactions_count_daily', row.transactions_count_daily, bucketDate);
    await this.replaceDimensionedDailyMetric(
      'transactions_volume_minor_daily',
      volumeRows.map((r) => ({ value: r.value, dimension: { currency: r.currency.trim() } })),
      bucketDate,
    );
  }

  /** One-shot bounded backfill helper for seeds/scripts; no scheduler or live side effect here. */
  async backfillDailyMetrics(from?: string, to?: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ min_date: string | null; max_date: string | null }>>`
      WITH source_dates AS (
        SELECT min((created_at AT TIME ZONE 'UTC')::date) AS min_date,
               max((created_at AT TIME ZONE 'UTC')::date) AS max_date
        FROM customers
        WHERE deleted_at IS NULL
        UNION ALL
        SELECT min((occurred_at AT TIME ZONE 'UTC')::date) AS min_date,
               max((occurred_at AT TIME ZONE 'UTC')::date) AS max_date
        FROM transactions
        WHERE status = 'POSTED'
      )
      SELECT min(min_date)::text AS min_date, max(max_date)::text AS max_date
      FROM source_dates`;
    const start = from ?? row.min_date;
    const end = to ?? row.max_date;
    if (!start || !end) return 0;

    let count = 0;
    for (let time = Date.parse(`${start}T00:00:00.000Z`), endTime = Date.parse(`${end}T00:00:00.000Z`);
      time <= endTime;
      time += 24 * 60 * 60 * 1000) {
      await this.rollupDailyMetrics(new Date(time).toISOString().slice(0, 10));
      count += 1;
    }
    return count;
  }

  /**
   * Live `now()` freshness stamp for the zero-customer KYC path.
   * Previously read the materialized view's refresh time; now returns the database clock so the
   * empty-distribution `asOf` is current and consistent with the live read path.
   */
  private async summaryAsOf(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<Array<{ as_of: Date }>>`SELECT now() AS as_of`;
    return row.as_of;
  }

  private async metricAsOf(metricKey: string): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ as_of: Date | null }>>`
      SELECT max(updated_at) AS as_of FROM metric_daily WHERE metric_key = ${metricKey}`;
    return row?.as_of ?? null;
  }

  private async upsertDailyMetric(
    metricKey: string,
    value: number | string,
    bucketDate?: string,
    dimension: Record<string, string> = {},
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO metric_daily (metric_key, bucket_date, dimension_json, value_numeric, updated_at)
      VALUES (
        ${metricKey},
        COALESCE(${bucketDate ?? null}::date, (now() AT TIME ZONE 'UTC')::date),
        ${JSON.stringify(dimension)}::jsonb,
        ${String(value)}::numeric,
        now()
      )
      ON CONFLICT (metric_key, bucket_date, dimension_json)
      DO UPDATE SET value_numeric = EXCLUDED.value_numeric, updated_at = EXCLUDED.updated_at`;
  }

  private async replaceDimensionedDailyMetric(
    metricKey: string,
    rows: Array<{ value: string; dimension: Record<string, string> }>,
    bucketDate?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM metric_daily
        WHERE metric_key = ${metricKey}
          AND bucket_date = COALESCE(${bucketDate ?? null}::date, (now() AT TIME ZONE 'UTC')::date)`;
      for (const row of rows) {
        await tx.$executeRaw`
          INSERT INTO metric_daily (metric_key, bucket_date, dimension_json, value_numeric, updated_at)
          VALUES (
            ${metricKey},
            COALESCE(${bucketDate ?? null}::date, (now() AT TIME ZONE 'UTC')::date),
            ${JSON.stringify(row.dimension)}::jsonb,
            ${String(row.value)}::numeric,
            now()
          )
          ON CONFLICT (metric_key, bucket_date, dimension_json)
          DO UPDATE SET value_numeric = EXCLUDED.value_numeric, updated_at = EXCLUDED.updated_at`;
      }
    });
  }
}

/** Part/total as a percentage rounded to one decimal; 0 when total is 0 (avoids divide-by-zero). */
function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function maxDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return right.getTime() > left.getTime() ? right : left;
}
