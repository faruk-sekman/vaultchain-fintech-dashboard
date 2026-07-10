/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Canonical analytics DDL. These objects are deliberately NOT in
 * prisma/schema.prisma because Prisma cannot express them:
 *   - materialized views (no Prisma model maps to a matview), and
 *   - metric_daily's composite PK includes a jsonb column (data-dictionary.md §metric_daily),
 *     which Prisma forbids in @@id.
 * They are created the same way the ledger DDL adds CHECK constraints + sequences: raw SQL via
 * $executeRawUnsafe. The integration suite applies these after the Prisma migrations; in a real
 * environment the same statements are the migration to run once the database is provisioned.
 *
 * Refresh + querying live in analytics.service.ts. The view names are exported so the service
 * and tests reference one source of truth.
 */

export const MV_CUSTOMER_SUMMARY = 'analytics.mv_customer_summary';
export const MV_KYC_DISTRIBUTION = 'analytics.mv_kyc_distribution';

/**
 * Ordered DDL statements. Run sequentially against a database that already has the foundation
 * schema (customers must exist before the views that aggregate it). Each entry is a single
 * statement so it can be sent through $executeRawUnsafe one at a time.
 */
export const ANALYTICS_DDL: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS analytics`,

  // Top-line KPIs over ALL customers — replaces the browser-side computation that was capped at
  // pageSize:60. No GROUP BY ⇒ exactly one row always (even at zero customers), so the service
  // can read row[0] unconditionally. `singleton` exists only to carry the UNIQUE index that
  // REFRESH MATERIALIZED VIEW CONCURRENTLY requires.
  `CREATE MATERIALIZED VIEW ${MV_CUSTOMER_SUMMARY} AS
   SELECT
     1                                               AS singleton,
     count(*)::int                                   AS total_customers,
     count(*) FILTER (WHERE status = 'ACTIVE')::int  AS active_count,
     count(*) FILTER (WHERE status <> 'ACTIVE')::int AS inactive_count,
     round(avg(date_part('year', age(date_of_birth)))::numeric, 0)::int AS age_avg,
     min(date_part('year', age(date_of_birth)))::int AS age_min,
     max(date_part('year', age(date_of_birth)))::int AS age_max,
     now()                                           AS as_of
   FROM customers
   WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX mv_customer_summary_uq ON ${MV_CUSTOMER_SUMMARY} (singleton)`,

  // KYC status distribution — one row per kyc_status present. Missing enum values are zero-filled
  // in the service (the view only emits statuses that occur).
  `CREATE MATERIALIZED VIEW ${MV_KYC_DISTRIBUTION} AS
   SELECT kyc_status::text AS status, count(*)::int AS count, now() AS as_of
   FROM customers
   WHERE deleted_at IS NULL
   GROUP BY kyc_status`,
  `CREATE UNIQUE INDEX mv_kyc_distribution_uq ON ${MV_KYC_DISTRIBUTION} (status)`,

  // Time-series rollup (idempotent). PK includes dimension_json per data-dictionary.md so future
  // dimensioned metrics (e.g. {"currency":"TRY"}) coexist; the daily job writes the empty object.
  `CREATE TABLE IF NOT EXISTS metric_daily (
     metric_key     text        NOT NULL,
     bucket_date    date        NOT NULL,
     dimension_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
     value_numeric  numeric     NOT NULL,
     updated_at     timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (metric_key, bucket_date, dimension_json)
   )`,
];
