/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Analytics screen (`/analytics`, design-system-ui-kit.md §7.2). Deeper analysis of
 * the REAL portfolio aggregates that already exist server-side, reusing the
 * dashboard's `DashboardStatsStore` read-only (`/dashboard/summary` +
 * `/dashboard/kyc-distribution`) plus the backend daily metrics endpoint
 * (`/metrics/daily`). It never fabricates or random-generates a chart series.
 */
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  BehaviorSubject,
  Observable,
  catchError,
  combineLatest,
  debounceTime,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs';

import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';
import {
  UiChartLineComponent,
  UiChartLineDatum,
} from '@shared/components/ui-chart-line/ui-chart-line.component';
import { IconPopDirective } from '@shared/directives/icon-pop.directive';
import {
  UiChartTipComponent,
  UiChartTipRow,
} from '@shared/components/ui-chart-tip/ui-chart-tip.component';
import { MetricsApi, type DailyMetrics, type DailyMetricItem } from '@core/api/metrics.api';
import { LocaleFormatService } from '@core/services/locale-format.service';
// O-6: the shared dashboard-stats slice lives in @core/state (consumed by both the dashboard and
// analytics routes), so this is a neutral @core dependency — no longer a feature→feature import.
import { DashboardStatsStore } from '@core/state/dashboard-metrics';
// A4: consume the existing self-healing SSE stream (shared @core realtime source).
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { DashboardSummary, KycDistribution } from '@core/api/dashboard.api';

/** A row in the real KYC "breakdown" top list. */
export interface AnalyticsBreakdownRow {
  readonly status: string;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
  readonly color: string;
  /** Remix icon for the row's 50px tile (v2.1 §3.3 G3 list rows). */
  readonly icon: string;
  /** Soft tile background — the row hue mixed to ~14% (presentational only). */
  readonly tileBg: string;
  /** Horizontal gradient fill for the row's bar (lighter hue → full hue). */
  readonly bar: string;
}

/** Time-range segments for the backend daily metrics query. */
export type AnalyticsRange = 'day' | 'week' | 'month';

interface MetricChartState {
  readonly data: UiChartLineDatum[];
  readonly loading: boolean;
  readonly error: unknown | null;
  readonly asOf: string | null;
}

/** Headline KPI readouts derived from the real aggregates (no fabricated values). */
interface AnalyticsKpis {
  readonly totalCustomers: number;
  readonly activeRate: number;
  readonly verifiedCount: number;
  readonly kycTotal: number;
}

/** Active vs inactive split for the status card's two-segment bar (REAL summary aggregates). */
interface AnalyticsStatusSplit {
  readonly active: number;
  readonly inactive: number;
  readonly total: number;
  readonly activePercent: number;
  readonly inactivePercent: number;
}

/** Maps a backend KYC status to a stable categorical chart hue (matches the dashboard). */
const KYC_CHART_HUE: Record<string, string> = {
  VERIFIED: 'var(--color-success)', // green — same success hue the dashboard uses (NOT the off-palette --chart-4 magenta)
  PENDING: 'var(--chart-5)', // amber
  IN_REVIEW: 'var(--chart-2)', // blue
  NOT_STARTED: 'var(--color-chart-muted-from)', // slate
  REJECTED: 'var(--chart-6)', // red
  EXPIRED: 'var(--chart-7)', // violet
};

/** Remix icon per KYC status for the G3 breakdown tiles (presentational only). */
const KYC_TILE_ICON: Record<string, string> = {
  VERIFIED: 'ri-shield-check-line',
  PENDING: 'ri-time-line',
  IN_REVIEW: 'ri-search-eye-line',
  NOT_STARTED: 'ri-shield-line',
  REJECTED: 'ri-close-circle-line',
  EXPIRED: 'ri-history-line',
};

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiCardComponent,
    UiEmptyComponent,
    UiSkeletonComponent,
    UiSegmentedComponent,
    UiChartLineComponent,
    UiChartTipComponent,
    IconPopDirective,
  ],
  templateUrl: './analytics.component.html',
  styleUrl: './analytics.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalyticsComponent implements OnInit {
  private readonly statsStore = inject(DashboardStatsStore);
  private readonly metricsApi = inject(MetricsApi);
  private readonly i18n = inject(TranslateService);
  private readonly fmt = inject(LocaleFormatService);
  /** Realtime SSE source (A4); `providedIn:'root'`, stubbed in specs (mirrors the dashboard). */
  private readonly stream = inject(DashboardStreamService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly rangeState$ = new BehaviorSubject<AnalyticsRange>('week');

  readonly summary$ = this.statsStore.summary$;
  readonly kyc$ = this.statsStore.kyc$;
  readonly loading$ = this.statsStore.loading$;
  readonly error$: Observable<unknown> = this.statsStore.error$ ?? of(null);

  /** Selected range — local view state only; never persisted, never filters real data. */
  range: AnalyticsRange = 'week';

  readonly rangeOptions: ReadonlyArray<UiSegmentItem> = [
    { value: 'day', labelKey: 'analytics.range.day' },
    { value: 'week', labelKey: 'analytics.range.week' },
    { value: 'month', labelKey: 'analytics.range.month' },
  ];

  /** Shared hover tooltip for the status / breakdown charts (set on mousemove). */
  tip: {
    visible: boolean;
    x: number;
    y: number;
    color: string;
    title: string;
    rows: UiChartTipRow[];
  } = {
    visible: false,
    x: 0,
    y: 0,
    color: '',
    title: '',
    rows: [],
  };

  private tipRows(count: number, percent: number): UiChartTipRow[] {
    return [
      { label: this.i18n.instant('analytics.kyc.centerCaption'), value: this.formatCount(count) },
      { label: this.i18n.instant('analytics.table.share'), value: `${percent}%` },
    ];
  }

  showBreakdownTip(event: MouseEvent, row: AnalyticsBreakdownRow): void {
    this.tip = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      color: row.color,
      title: row.label,
      rows: this.tipRows(row.count, row.percent),
    };
  }

  showStatusTip(event: MouseEvent, kind: 'active' | 'inactive', s: AnalyticsStatusSplit): void {
    const active = kind === 'active';
    this.tip = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      color: active ? 'var(--brand-500)' : 'var(--color-chart-muted-from)',
      title: this.i18n.instant(active ? 'dashboard.labels.active' : 'dashboard.labels.inactive'),
      rows: this.tipRows(
        active ? s.active : s.inactive,
        active ? s.activePercent : s.inactivePercent,
      ),
    };
  }

  hideTip(): void {
    this.tip = { ...this.tip, visible: false };
  }

  /** Active vs inactive split (REAL: `/dashboard/summary`) → a clean two-segment bar. */
  readonly statusSplit$: Observable<AnalyticsStatusSplit | null> = this.summary$.pipe(
    map(summary => this.toStatusSplit(summary)),
  );

  /** KYC breakdown top list, highest count first (REAL: `/dashboard/kyc-distribution`). */
  readonly breakdown$: Observable<AnalyticsBreakdownRow[]> = this.kyc$.pipe(
    map(kyc => this.toBreakdown(kyc)),
  );

  /** Headline KPI tiles derived from the REAL aggregates (summary + KYC distribution). */
  readonly kpis$: Observable<AnalyticsKpis> = combineLatest([this.summary$, this.kyc$]).pipe(
    map(([summary, kyc]) => {
      const total = summary?.totalCustomers ?? 0;
      const active = summary?.activeCount ?? 0;
      const verified = kyc?.items.find(item => item.status === 'VERIFIED');
      return {
        totalCustomers: total,
        activeRate: total > 0 ? Math.round((active / total) * 100) : 0,
        verifiedCount: verified?.count ?? 0,
        kycTotal: kyc?.total ?? 0,
      };
    }),
  );

  /** Transaction volume over time (REAL: `/metrics/daily`). */
  readonly volumeState$: Observable<MetricChartState> = this.rangeState$.pipe(
    switchMap(range => {
      return this.loadVolumeMetric(range).pipe(
        map(metric => ({
          data: this.toVolumeData(metric.items),
          loading: false,
          error: null,
          asOf: metric.asOf,
        })),
        catchError(error =>
          of({
            data: [],
            loading: false,
            error,
            asOf: null,
          }),
        ),
        startWith({
          data: [],
          loading: true,
          error: null,
          asOf: null,
        }),
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  private loadVolumeMetric(range: AnalyticsRange): Observable<DailyMetrics> {
    const bounds = metricBoundsForRange(range);
    return this.metricsApi
      .getDaily({
        metric: 'transactions_volume_minor_daily',
        from: bounds.from,
        to: bounds.to,
      })
      .pipe(
        switchMap(metric => {
          if (range !== 'day' || hasPositiveMetricItems(metric.items)) return of(metric);
          const fallbackBounds = metricBoundsForRange('week');
          return this.metricsApi
            .getDaily({
              metric: 'transactions_volume_minor_daily',
              from: fallbackBounds.from,
              to: fallbackBounds.to,
            })
            .pipe(
              map(fallbackMetric => latestPositiveMetric(fallbackMetric) ?? metric),
              catchError(() => of(metric)),
            );
        }),
      );
  }

  /** True only when all real sources resolved with zero data (whole-page empty). */
  readonly allEmpty$: Observable<boolean> = combineLatest([
    this.summary$,
    this.kyc$,
    this.volumeState$,
  ]).pipe(
    map(([summary, kyc, volume]) => {
      const noCustomers = !summary || summary.totalCustomers === 0;
      const noKyc = !kyc || kyc.total === 0;
      const noVolume = !volume.loading && !volume.error && volume.data.length === 0;
      return noCustomers && noKyc && noVolume;
    }),
  );

  ngOnInit(): void {
    this.statsStore.load();

    // Realtime (SSE, A4): a customer mutation anywhere pushes a PII-free signal;
    // re-pull the shared summary/KYC aggregates so the KPIs + distribution stay live (like the
    // dashboard). Only the summary goes live — the `/metrics/daily` volume/trend stays cron-backed
    // (out of scope). Debounced to coalesce bursts; idempotent reload; torn down via DestroyRef
    // (mirrors the dashboard).
    this.stream
      .connect()
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.statsStore.load());
  }

  /** Re-dispatch the shared aggregates load (page retry). */
  reload(): void {
    this.statsStore.load();
  }

  onRangeChange(value: string): void {
    this.range = value === 'day' || value === 'month' ? value : 'week';
    this.rangeState$.next(this.range);
  }

  reloadMetrics(): void {
    this.rangeState$.next(this.range);
  }

  /** Already-translated range label for the volume panel caption. */
  get rangeLabel(): string {
    return this.i18n.instant(`analytics.range.${this.range}`);
  }

  /**
   * Formats counts via the central locale service (B2) — active-language grouping, live on switch.
   */
  readonly formatCount = (value: number): string => this.fmt.number(value);

  /**
   * Localized "as of" date for the freshness chip — the real backend metric `asOf`
   * (never a fabricated timestamp). Returns null when no freshness is known so the
   * template can fall back to the live skeleton/label instead of inventing a date.
   */
  formatAsOf(asOf: string | null): string | null {
    if (!asOf) return null;
    const iso = asOf.length === 10 ? `${asOf}T00:00:00.000Z` : asOf;
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return null;
    return this.fmt.date(iso, 'mediumDate', 'UTC');
  }

  /** i18n key for a backend KYC status (reuses the dashboard's labels). */
  kycLabelKey(status: string): string {
    return `dashboard.kyc.${status}`;
  }

  private kycLabel(status: string): string {
    return this.i18n.instant(this.kycLabelKey(status));
  }

  private kycColor(status: string): string {
    return KYC_CHART_HUE[status] ?? 'var(--color-chart-muted-from)';
  }

  private kycIcon(status: string): string {
    return KYC_TILE_ICON[status] ?? 'ri-shield-line';
  }

  private toStatusSplit(summary: DashboardSummary | null): AnalyticsStatusSplit | null {
    if (!summary || summary.totalCustomers === 0) return null;
    const total = summary.totalCustomers;
    return {
      active: summary.activeCount,
      inactive: summary.inactiveCount,
      total,
      activePercent: Math.round((summary.activeCount / total) * 100),
      inactivePercent: Math.round((summary.inactiveCount / total) * 100),
    };
  }

  private toBreakdown(kyc: KycDistribution | null): AnalyticsBreakdownRow[] {
    if (!kyc || kyc.total === 0) return [];
    return kyc.items
      .filter(item => item.count > 0)
      .slice()
      .sort((a, b) => b.count - a.count)
      .map(item => {
        const color = this.kycColor(item.status);
        return {
          status: item.status,
          label: this.kycLabel(item.status),
          count: item.count,
          percent: item.percent,
          color,
          icon: this.kycIcon(item.status),
          tileBg: `color-mix(in srgb, ${color} 14%, transparent)`,
          bar: `linear-gradient(90deg, color-mix(in srgb, ${color} 62%, #fff) 0%, ${color} 100%)`,
        };
      });
  }

  trackByBreakdown(_index: number, row: AnalyticsBreakdownRow): string {
    return row.status;
  }

  /**
   * Backend `/metrics/daily` returns ONE row per day that has a `metric_daily` bucket — days with no
   * posted volume are simply absent. The line chart spaces points by array index, so plotting those
   * sparse rows back-to-back would compress a multi-day gap into one step (a non-linear time axis).
   * To keep the axis linear/real, we gap-fill every calendar day between the first and last returned
   * date: a day with no bucket genuinely has zero volume (honest, not fabricated), so it becomes a
   * 0-valued point. Index spacing then equals real-day spacing. Empty/zero-only input stays empty so
   * the no-data state still fires.
   */
  private toVolumeData(items: ReadonlyArray<{ date: string; value: string }>): UiChartLineDatum[] {
    const byDay = new Map<string, number>();
    for (const item of items) {
      const day = dayStartUtc(item.date);
      if (day !== null) byDay.set(item.date.slice(0, 10), safeNumber(item.value));
    }
    if (byDay.size === 0) return [];

    const dayKeys = [...byDay.keys()].sort();
    const firstMs = dayStartUtc(dayKeys[0]);
    const lastMs = dayStartUtc(dayKeys[dayKeys.length - 1]);
    if (firstMs === null || lastMs === null) return [];

    const points: UiChartLineDatum[] = [];
    for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) {
      const iso = new Date(ms).toISOString();
      const key = iso.slice(0, 10);
      points.push({
        label: this.fmt.date(iso, 'MMM d', 'UTC'),
        values: [byDay.get(key) ?? 0],
      });
    }
    return hasPositiveLineData(points) ? points : [];
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses a `YYYY-MM-DD` (or longer ISO) day to its UTC-midnight epoch ms, or null when unparseable. */
function dayStartUtc(date: string): number | null {
  const time = Date.parse(`${date.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(time) ? time : null;
}

function hasPositiveLineData(points: ReadonlyArray<UiChartLineDatum>): boolean {
  return points.some(point => point.values.some(value => value > 0));
}

function hasPositiveMetricItems(items: ReadonlyArray<DailyMetricItem>): boolean {
  return items.some(item => safeNumber(item.value) > 0);
}

function latestPositiveMetric(metric: DailyMetrics): DailyMetrics | null {
  const latest = metric.items
    .filter(item => safeNumber(item.value) > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  return latest ? { ...metric, items: [latest] } : null;
}

function metricBoundsForRange(range: AnalyticsRange): { from: string; to: string } {
  // Windows aligned to the Day/Week/Month segment labels (audit D10): day = 1, week = 7, month = 30.
  const days = range === 'day' ? 1 : range === 'month' ? 30 : 7;
  const today = new Date();
  const to = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const from = to - (days - 1) * 24 * 60 * 60 * 1000;
  return {
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(to).toISOString().slice(0, 10),
  };
}

function safeNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
