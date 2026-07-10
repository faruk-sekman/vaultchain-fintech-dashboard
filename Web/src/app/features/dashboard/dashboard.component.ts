/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dashboard (v2.1 rows): consumes the server-side aggregates from
 * `DashboardStatsStore` (`/dashboard/summary` + `/dashboard/kyc-distribution`) plus the recent
 * customers slice (`GET /dashboard/recent-customers`, top 3, PII-masked) and recomposes the
 * SAME data into the §5 v2.1 row contract: Row 0 secondary KPI pills · Row 1 outline hero pair
 * (total+split / verified-KYC) + "Recent Customers" 3-row list · Row 2 full-width KYC distribution
 * bar · Row 3 quick-action rows + backend-backed trend. Each datum is rendered once (G7 dedup):
 * the grand total and active/pasif split live only on the Row-1 overview hero, and KYC has a single
 * chart (the Row-2 bar) — the earlier gradient "credit-card" hero, duplicate total pill, KYC ring,
 * and Active/Passive donut were removed (design revision).
 *
 * Realtime: subscribes to the SSE stream (DashboardStreamService); each customer mutation pushes a
 * PII-free signal that re-pulls the aggregates + recent list, so the dashboard updates live.
 */
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  BehaviorSubject,
  Observable,
  catchError,
  combineLatest,
  debounceTime,
  forkJoin,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { DashboardSummary, KycDistribution } from '@core/api/dashboard.api';
import { DailyMetricKey, DailyMetrics, MetricsApi } from '@core/api/metrics.api';
import { UiBadgeComponent, UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import {
  UiChartBarComponent,
  UiChartBarDatum,
  UiChartBarSeries,
} from '@shared/components/ui-chart-bar/ui-chart-bar.component';
import {
  UiChartLineComponent,
  UiChartLineDatum,
  UiChartLineSeries,
} from '@shared/components/ui-chart-line/ui-chart-line.component';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';
import {
  UiHeroCardComponent,
  UiHeroCardMeta,
  UiHeroCardSegment,
} from '@shared/components/ui-hero-card/ui-hero-card.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { UiStatCardComponent } from '@shared/components/ui-stat-card/ui-stat-card.component';
import { getKycStatusBadgeColor } from '@shared/utils/kyc-status';
import { DashboardStatsStore } from '@core/state/dashboard-metrics';
import { LatestCustomerStore } from '@features/dashboard/state';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';

/** KYC bar-chart view model (data + named series resolve together). */
export interface KycBarVm {
  readonly data: UiChartBarDatum[];
  readonly series: UiChartBarSeries[];
}

/** Hero card 1 (outline): Total Customers + active/passive split + ratio footnote (§5 row 1, sole total owner). */
export interface OverviewHeroVm {
  readonly value: string;
  readonly meta: UiHeroCardMeta[];
  readonly segments: UiHeroCardSegment[];
  readonly ratioLine: string;
}

/** Hero card 2 (outline): Verified KYC count + verified-share & asOf meta (§5 row 1). */
export interface KycHeroVm {
  readonly value: string;
  readonly meta: UiHeroCardMeta[];
  /** Verified share (0–100); surfaced as a meta value (the ring chart was dropped, G7). */
  readonly share: number;
}

interface MetricChartState {
  readonly data: UiChartLineDatum[];
  readonly series: UiChartLineSeries[];
  readonly loading: boolean;
  readonly error: unknown | null;
}

/**
 * Canonical backend KYC lifecycle order — the §5 row-2 bar card renders one
 * bar per status (6 bars), zero counts included, so the distribution shape is
 * honest even when a status has no customers yet.
 */
const KYC_STATUS_ORDER: ReadonlyArray<string> = [
  'NOT_STARTED',
  'PENDING',
  'IN_REVIEW',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
];

/** KYC status → chart hue, aligned with the badge colour semantics used across the app. */
const KYC_STATUS_HUE: Record<string, string> = {
  NOT_STARTED: 'var(--chart-5)',
  PENDING: 'var(--chart-7)',
  IN_REVIEW: 'var(--chart-6)',
  VERIFIED: 'var(--color-success)',
  REJECTED: 'var(--color-danger)',
  EXPIRED: 'var(--color-warning)',
};

const TREND_METRICS: ReadonlyArray<DailyMetricKey> = [
  'customers_new_daily',
  'customers_active_total_daily',
  'transactions_count_daily',
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    TranslateModule,
    UiBadgeComponent,
    UiCardComponent,
    UiChartBarComponent,
    UiChartLineComponent,
    UiEmptyComponent,
    UiHeroCardComponent,
    UiSkeletonComponent,
    UiStatCardComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly statsStore = inject(DashboardStatsStore);
  private readonly latestStore = inject(LatestCustomerStore);
  private readonly router = inject(Router);
  private readonly i18n = inject(TranslateService);
  private readonly fmt = inject(LocaleFormatService);
  private readonly metricsApi = inject(MetricsApi);
  private readonly stream = inject(DashboardStreamService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly trendReload$ = new BehaviorSubject<void>(undefined);
  /** Same defense-in-depth gate as the customers list: manage actions stay hidden without the permission. */
  protected readonly auth = inject(AuthService);

  readonly summary$ = this.statsStore.summary$;
  readonly kyc$ = this.statsStore.kyc$;
  readonly loading$ = this.statsStore.loading$;
  // `error$` is additive on the store; fall back to a null stream for lean test doubles.
  readonly statsError$: Observable<unknown> = this.statsStore.error$ ?? of(null);

  /** §5 row 1 "Recent Customers": 3 most recently updated customers (masked upstream). */
  readonly recent$ = this.latestStore.recent$;
  readonly recentLoading$ = this.latestStore.recentLoading$;
  readonly recentLoaded$ = this.latestStore.recentLoaded$;
  readonly recentError$: Observable<unknown> = this.latestStore.recentError$ ?? of(null);

  /**
   * Re-emits on every language switch so the `instant()`-built VM labels below rebuild live (B1,
   * bugfix-backlog-2026-07): the hero meta/split labels used to freeze in whichever language was
   * active when the data arrived ("aktif/pasif" surviving an EN switch and vice versa).
   */
  private readonly lang$ = this.i18n.onLangChange.pipe(startWith(null));

  /** Hero card 1 (gradient) — Total Customers + active/passive meta (REAL: `/dashboard/summary`). */
  readonly overviewHero$: Observable<OverviewHeroVm | null> = combineLatest([
    this.summary$,
    this.lang$,
  ]).pipe(map(([summary]) => this.toOverviewHero(summary)));

  /** Hero card 2 (outline) — Verified KYC + % + asOf (REAL: `/dashboard/kyc-distribution`). */
  readonly kycHero$: Observable<KycHeroVm | null> = combineLatest([this.kyc$, this.lang$]).pipe(
    map(([kyc]) => this.toKycHero(kyc)),
  );

  /** KYC distribution → 6 status bars in lifecycle order (REAL: `/dashboard/kyc-distribution`). */
  readonly kycBar$: Observable<KycBarVm> = combineLatest([this.kyc$, this.lang$]).pipe(
    map(([kyc]) => this.toKycBar(kyc)),
  );

  /**
   * Raw trend fetch — SEPARATED from labeling so a language switch relabels the chart without
   * re-hitting `/metrics/daily` (B1).
   */
  private readonly trendRaw$ = this.trendReload$.pipe(
    switchMap(() => {
      const bounds = metricBoundsForDays(30);
      return forkJoin(
        TREND_METRICS.map(metric =>
          this.metricsApi.getDaily({ metric, from: bounds.from, to: bounds.to }),
        ),
      ).pipe(
        map(metrics => ({ metrics, loading: false, error: null as unknown })),
        catchError(error =>
          of({ metrics: [] as ReadonlyArray<DailyMetrics>, loading: false, error }),
        ),
        startWith({
          metrics: [] as ReadonlyArray<DailyMetrics>,
          loading: true,
          error: null as unknown,
        }),
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** Customer trend over time (REAL: `/metrics/daily`); labels re-derive on language switch. */
  readonly trendState$: Observable<MetricChartState> = combineLatest([
    this.trendRaw$,
    this.lang$,
  ]).pipe(
    map(([raw]) => ({
      data: this.toMultiLineData(raw.metrics),
      series: this.trendSeries(),
      loading: raw.loading,
      error: raw.error,
    })),
  );

  /** Stable skeleton placeholder rows for the recent-customers list (3 rows, G3). */
  readonly recentSkeletonRows: ReadonlyArray<number> = [0, 1, 2];

  ngOnInit(): void {
    this.statsStore.load();
    this.latestStore.loadRecent();

    // Realtime (SSE): a customer mutation anywhere pushes a PII-free signal; re-pull the masked
    // aggregates + recent list so the dashboard stays live. Debounced to coalesce bursts; the
    // subscription is torn down (and the stream closed) when the component is destroyed.
    this.stream
      .connect()
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.statsStore.load();
        this.latestStore.loadRecent();
      });
  }

  /** Re-dispatch the portfolio-stats load (KPI + hero + charts region retry). */
  reloadStats(): void {
    this.statsStore.load();
  }

  /** Re-dispatch the recent-customers load (Recent Customers region retry). */
  reloadRecent(): void {
    this.latestStore.loadRecent();
  }

  /** Re-dispatch the customer trend load. */
  reloadTrend(): void {
    this.trendReload$.next();
  }

  /** Quick action — REAL route only (customer create form). */
  goToCreateCustomer(): void {
    this.router.navigate(['/customers/new']);
  }

  /** Quick action — REAL route only (analytics screen). */
  goToAnalytics(): void {
    this.router.navigate(['/analytics']);
  }

  /** Quick action — REAL route only (customers list). */
  goToCustomers(): void {
    this.router.navigate(['/customers']);
  }

  /** i18n key for a backend KYC status; falls back to the raw code if unmapped. */
  kycLabelKey(status: string): string {
    return `dashboard.kyc.${status}`;
  }

  /** Badge colour family for a backend KYC status (shared single source of truth). */
  kycBadgeColor(status: string): UiBadgeColor {
    return getKycStatusBadgeColor(status);
  }

  /**
   * Formats a customer count for chart axes/legends/centres via the central locale service (B2)
   * — the ACTIVE language's grouping (1.500 vs 1,500), live on a language switch.
   */
  readonly formatCount = (value: number | null | undefined): string =>
    this.fmt.number(safeNumber(value));

  readonly formatPercent = (value: number | null | undefined): string => `${safePercent(value)}%`;

  readonly formatAverageAge = (
    value: number | null | undefined,
    yearsLabel: string,
  ): string | null => (isFiniteNumber(value) ? `${this.formatCount(value)} ${yearsLabel}` : null);

  private toOverviewHero(summary: DashboardSummary | null): OverviewHeroVm | null {
    if (!summary) return null;
    const totalCustomers = safeNumber(summary.totalCustomers);
    const activeCount = safeNumber(summary.activeCount);
    const inactiveCount = safeNumber(summary.inactiveCount);
    const activeRate = safePercent(summary.activeRate, derivePercent(activeCount, totalCustomers));
    const inactiveRate = safePercent(
      summary.inactiveRate,
      derivePercent(inactiveCount, totalCustomers),
    );
    const active = this.i18n.instant('dashboard.labels.active');
    const inactive = this.i18n.instant('dashboard.labels.inactive');
    return {
      value: this.formatCount(totalCustomers),
      meta: [
        { label: active, value: this.formatCount(activeCount) },
        { label: inactive, value: this.formatCount(inactiveCount) },
      ],
      // Active vs inactive as a visual split bar (segment widths from the REAL rates).
      segments: [
        { label: active, value: this.formatCount(activeCount), pct: activeRate },
        {
          label: inactive,
          value: this.formatCount(inactiveCount),
          pct: inactiveRate,
        },
      ],
      // The G6 bottom line carries the REAL active/inactive ratio (no card PAN exists here).
      ratioLine: `${activeRate}% ${active} · ${inactiveRate}% ${inactive}`,
    };
  }

  private toKycHero(kyc: KycDistribution | null): KycHeroVm | null {
    if (!kyc) return null;
    const items = kycItems(kyc);
    const verified = items.find(item => item.status === 'VERIFIED');
    const share = safePercent(verified?.percent);
    return {
      value: this.formatCount(verified?.count),
      // The KYC ring was dropped (the Row-2 bar is the one KYC chart, G7); the verified share rides
      // as a plain meta value so the % is still stated, alongside the freshness stamp.
      meta: [
        {
          label: this.i18n.instant('dashboard.hero.verifiedShare'),
          value: this.formatPercent(share),
        },
        {
          label: this.i18n.instant('dashboard.asOf'),
          value: this.formatAsOf(kyc.asOf),
        },
      ],
      share,
    };
  }

  private toKycBar(kyc: KycDistribution | null): KycBarVm {
    const items = kycItems(kyc);
    if (!kyc || safeNumber(kyc.total) === 0 || items.length === 0) {
      return { data: [], series: [] };
    }
    const counts = new Map(items.map(item => [item.status, safeNumber(item.count)]));
    return {
      data: KYC_STATUS_ORDER.map(status => ({
        label: this.i18n.instant(this.kycLabelKey(status)),
        values: [counts.get(status) ?? 0],
        color: KYC_STATUS_HUE[status],
      })),
      series: [{ name: this.i18n.instant('customers.title') }],
    };
  }

  private formatAsOf(value: unknown): string {
    if (!isValidDateInput(value)) return '—';
    return this.fmt.date(value, 'shortDate');
  }

  private trendSeries(): UiChartLineSeries[] {
    return [
      { name: this.i18n.instant('dashboard.trend.series.newCustomers'), area: true },
      { name: this.i18n.instant('dashboard.trend.series.activeCustomers') },
      { name: this.i18n.instant('dashboard.trend.series.transactions') },
    ];
  }

  private toMultiLineData(metrics: ReadonlyArray<DailyMetrics>): UiChartLineDatum[] {
    const dates = new Set<string>();
    const byMetric = new Map<DailyMetricKey, Map<string, number>>();
    for (const metric of metrics) {
      const values = new Map<string, number>();
      for (const item of metric.items) {
        dates.add(item.date);
        values.set(item.date, safeNumber(item.value));
      }
      byMetric.set(metric.metric, values);
    }

    const points = [...dates].sort().map(date => ({
      label: this.fmt.date(`${date}T00:00:00.000Z`, 'MMM d', 'UTC'),
      values: TREND_METRICS.map(metric => byMetric.get(metric)?.get(date) ?? 0),
    }));
    return hasPositiveLineData(points) ? points : [];
  }
}

function hasPositiveLineData(points: ReadonlyArray<UiChartLineDatum>): boolean {
  return points.some(point => point.values.some(value => value > 0));
}

function metricBoundsForDays(days: number): { from: string; to: string } {
  const today = new Date();
  const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const from = to - (days - 1) * 24 * 60 * 60 * 1000;
  return {
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(to).toISOString().slice(0, 10),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safePercent(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) {
    return Math.max(0, Math.min(100, safeNumber(fallback)));
  }
  const n = Number(value);
  const resolved = Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(100, safeNumber(resolved)));
}

function derivePercent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function kycItems(kyc: KycDistribution | null): KycDistribution['items'] {
  return Array.isArray(kyc?.items) ? kyc.items : [];
}

function isValidDateInput(value: unknown): value is string | number | Date {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}
