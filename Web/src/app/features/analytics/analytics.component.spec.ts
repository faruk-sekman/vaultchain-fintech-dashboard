/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Observable, Subject, filter, firstValueFrom, of, skip, throwError } from 'rxjs';

import { DashboardStatsStore } from '@core/state/dashboard-metrics';
import { DashboardEvent, DashboardSummary, KycDistribution } from '@core/api/dashboard.api';
import { MetricsApi } from '@core/api/metrics.api';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { AnalyticsComponent } from './analytics.component';

/** TranslateService stub: `instant` echoes the key so assertions stay deterministic. */
function i18nMock() {
  return {
    currentLang: 'en',
    instant: (key: string) => key,
  } as unknown as TranslateService;
}

interface StoreStub {
  summary$: Observable<DashboardSummary | null>;
  kyc$: Observable<KycDistribution | null>;
  loading$: Observable<boolean>;
  error$: Observable<unknown>;
  load: ReturnType<typeof vi.fn>;
}

function metricsMock() {
  return {
    getDaily: vi.fn(() =>
      of({
        metric: 'transactions_volume_minor_daily' as const,
        items: [],
        asOf: '2026-06-11T00:00:00.000Z',
      }),
    ),
  };
}

function storeMock(overrides: Partial<StoreStub> = {}): StoreStub {
  return {
    summary$: of(null),
    kyc$: of(null),
    loading$: of(false),
    error$: of(null),
    load: vi.fn(),
    ...overrides,
  };
}

function mount(store: StoreStub, metrics = metricsMock(), stream$ = new Subject<DashboardEvent>()) {
  // Reset first so a single `it` can mount more than one instance (e.g. the
  // allEmpty / error-fallback cases) without "module already instantiated".
  TestBed.resetTestingModule();
  // Realtime SSE stream: a controllable Subject so a test can emit an event and assert the
  // debounced re-load (A4). Existing tests never emit, so they are unaffected.
  const stream = { connect: vi.fn(() => stream$) };
  TestBed.configureTestingModule({
    providers: [
      { provide: DashboardStatsStore, useValue: store },
      { provide: MetricsApi, useValue: metrics },
      { provide: TranslateService, useValue: i18nMock() },
      { provide: DashboardStreamService, useValue: stream },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new AnalyticsComponent());
  return { component, metrics, stream$ };
}

const SUMMARY: DashboardSummary = {
  totalCustomers: 960,
  activeCount: 820,
  inactiveCount: 140,
  activeRate: 85.4,
  inactiveRate: 14.6,
  ageStats: { avg: 37, min: 18, max: 80 },
  asOf: '2026-06-11T00:00:00.000Z',
};

const KYC: KycDistribution = {
  total: 960,
  asOf: '2026-06-11T00:00:00.000Z',
  items: [
    { status: 'PENDING', count: 300, percent: 31.3 },
    { status: 'VERIFIED', count: 500, percent: 52.1 },
    { status: 'REJECTED', count: 160, percent: 16.6 },
  ],
};

describe('AnalyticsComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('ngOnInit loads the shared dashboard aggregates', () => {
    const store = storeMock();
    const { component } = mount(store);
    component.ngOnInit();
    expect(store.load).toHaveBeenCalledWith();
  });

  it('re-loads the aggregates when an SSE event arrives (debounced, A4)', () => {
    vi.useFakeTimers();
    const store = storeMock();
    const { component, stream$ } = mount(store);
    component.ngOnInit();
    expect(store.load).toHaveBeenCalledTimes(1); // initial load

    // A customer mutation elsewhere pushes a PII-free signal → debounced re-load of the KPIs.
    stream$.next({ type: 'customer.created', customerId: 'c-1', at: '2026-06-18T00:00:00.000Z' });
    vi.advanceTimersByTime(300);
    expect(store.load).toHaveBeenCalledTimes(2);

    // A burst inside the debounce window coalesces into a single extra load.
    stream$.next({ type: 'customer.updated', customerId: 'c-1', at: '2026-06-18T00:00:01.000Z' });
    stream$.next({ type: 'customer.deleted', customerId: 'c-1', at: '2026-06-18T00:00:01.100Z' });
    vi.advanceTimersByTime(300);
    expect(store.load).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('loads transaction volume from /metrics/daily instead of a static series', async () => {
    const metrics = metricsMock();
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [
          { date: '2026-06-10', value: '125000' },
          { date: '2026-06-11', value: '150000' },
        ],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    );
    const { component } = mount(storeMock(), metrics);

    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    expect(metrics.getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'transactions_volume_minor_daily' }),
    );
    expect(state.data.map(p => p.values[0])).toEqual([125000, 150000]);
    expect(state.asOf).toBe('2026-06-11T12:00:00.000Z');
  });

  it('gap-fills missing interior days so the volume date axis stays linear (real-day spacing)', async () => {
    const metrics = metricsMock();
    // Backend returns ONLY days that have a bucket: Jun 10 and Jun 12 — Jun 11 is absent.
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [
          { date: '2026-06-10', value: '125000' },
          { date: '2026-06-12', value: '150000' },
        ],
        asOf: '2026-06-12T12:00:00.000Z',
      }),
    );
    const { component } = mount(storeMock(), metrics);

    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    // The chart spaces points by index, so the absent Jun 11 must become a real 0-valued point
    // between the two — otherwise a 2-day gap would compress into a single step (non-linear axis).
    expect(state.data.map(p => p.values[0])).toEqual([125000, 0, 150000]);
    expect(state.data).toHaveLength(3);
  });

  it('treats zero-only transaction volume as no data', async () => {
    const metrics = metricsMock();
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [
          { date: '2026-06-10', value: '0' },
          { date: '2026-06-11', value: '0' },
        ],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    );
    const { component } = mount(storeMock(), metrics);

    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    expect(state.data).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('reload re-dispatches the aggregates load (retry)', () => {
    const store = storeMock();
    const { component } = mount(store);
    component.reload();
    expect(store.load).toHaveBeenCalledWith();
  });

  it('maps the REAL active/inactive split to a two-segment status split', async () => {
    const { component } = mount(storeMock({ summary$: of(SUMMARY) }));
    const split = await firstValueFrom(component.statusSplit$);
    expect(split).not.toBeNull();
    expect(split?.active).toBe(820);
    expect(split?.inactive).toBe(140);
    expect(split?.total).toBe(960);
    // Percentages are rounded against the REAL total (820/960 ≈ 85, 140/960 ≈ 15).
    expect(split?.activePercent).toBe(85);
    expect(split?.inactivePercent).toBe(15);
  });

  it('builds the KYC breakdown sorted by count desc (REAL field)', async () => {
    const { component } = mount(storeMock({ kyc$: of(KYC) }));
    const rows = await firstValueFrom(component.breakdown$);
    expect(rows.map(r => r.status)).toEqual(['VERIFIED', 'PENDING', 'REJECTED']);
    expect(rows[0].count).toBe(500);
  });

  it('decorates breakdown rows with a G3 tile icon + soft tile hue (presentational)', async () => {
    const { component } = mount(storeMock({ kyc$: of(KYC) }));
    const rows = await firstValueFrom(component.breakdown$);
    expect(rows[0].icon).toBe('ri-shield-check-line'); // VERIFIED
    expect(rows[0].color).toBe('var(--color-success)'); // VERIFIED → green (matches dashboard, NOT --chart-4 magenta)
    expect(rows[0].tileBg).toBe('color-mix(in srgb, var(--color-success) 14%, transparent)');
    expect(rows[2].icon).toBe('ri-close-circle-line'); // REJECTED
  });

  it('returns empty derived data when there is no real data (no fabrication)', async () => {
    const { component } = mount(storeMock());
    expect(await firstValueFrom(component.statusSplit$)).toBeNull();
    expect(await firstValueFrom(component.breakdown$)).toEqual([]);
  });

  it('flags allEmpty only when BOTH aggregates resolved with zero data', async () => {
    const emptyKyc: KycDistribution = { total: 0, asOf: KYC.asOf, items: [] };
    const emptySummary: DashboardSummary = { ...SUMMARY, totalCustomers: 0 };

    const empty = mount(storeMock({ summary$: of(emptySummary), kyc$: of(emptyKyc) }));
    expect(await firstValueFrom(empty.component.allEmpty$.pipe(skip(1)))).toBe(true);

    const partial = mount(storeMock({ summary$: of(SUMMARY), kyc$: of(emptyKyc) }));
    expect(await firstValueFrom(partial.component.allEmpty$.pipe(skip(1)))).toBe(false);
  });

  it('range selection refreshes the backend metric query', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockClear();

    expect(component.range).toBe('week');
    component.onRangeChange('month');
    expect(component.range).toBe('month');
    expect(component.rangeLabel).toBe('analytics.range.month');
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    expect(metrics.getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'transactions_volume_minor_daily' }),
    );

    // Guards an unknown value back to the default.
    component.onRangeChange('bogus');
    expect(component.range).toBe('week');
  });

  it('error$ falls back to a null stream when the store omits it (lean doubles)', async () => {
    const store = storeMock();
    delete (store as Partial<StoreStub>).error$;
    const { component } = mount(store as StoreStub);
    expect(await firstValueFrom(component.error$)).toBeNull();
  });

  // --- audit 9C: shared tooltip, freshness formatting, metric reload, locale grouping ---

  it('shows and hides the shared chart tooltip (breakdown / status)', () => {
    const { component } = mount(storeMock());
    const event = { clientX: 12, clientY: 34 } as MouseEvent;

    component.showBreakdownTip(event, {
      status: 'PENDING',
      label: 'Pending',
      color: 'amber',
      count: 300,
      percent: 31,
    } as never);
    expect(component.tip.visible).toBe(true);
    expect(component.tip.title).toBe('Pending');
    expect(component.tip.rows).toHaveLength(2);

    const split = {
      active: 800,
      inactive: 160,
      total: 960,
      activePercent: 83,
      inactivePercent: 17,
    } as never;
    component.showStatusTip(event, 'active', split);
    expect(component.tip.visible).toBe(true);
    component.showStatusTip(event, 'inactive', split);
    expect(component.tip.title).toBe('dashboard.labels.inactive');

    component.hideTip();
    expect(component.tip.visible).toBe(false);
  });

  it('formatAsOf renders a real date or null (never a fabricated stamp)', () => {
    const { component } = mount(storeMock());
    expect(component.formatAsOf(null)).toBeNull();
    expect(component.formatAsOf('not-a-date')).toBeNull();
    expect(component.formatAsOf('2026-06-11')).toBeTruthy(); // date-only → padded to UTC midnight
    expect(component.formatAsOf('2026-06-11T12:00:00.000Z')).toBeTruthy();
  });

  it('reloadMetrics re-runs the current-range metric query', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockClear();
    component.reloadMetrics();
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    expect(metrics.getDaily).toHaveBeenCalled();
  });

  it('kycLabelKey maps to the shared dashboard namespace', () => {
    const { component } = mount(storeMock());
    expect(component.kycLabelKey('VERIFIED')).toBe('dashboard.kyc.VERIFIED');
  });

  it('derives the headline KPIs from the REAL aggregates (summary + KYC distribution)', async () => {
    const { component } = mount(storeMock({ summary$: of(SUMMARY), kyc$: of(KYC) }));
    const kpis = await firstValueFrom(component.kpis$);
    expect(kpis.totalCustomers).toBe(960);
    // activeRate = round(820/960*100) = 85; verifiedCount from the VERIFIED bucket; kycTotal from total.
    expect(kpis.activeRate).toBe(85);
    expect(kpis.verifiedCount).toBe(500);
    expect(kpis.kycTotal).toBe(960);
  });

  it('KPI activeRate is an honest 0% (not NaN) when there are no customers (total>0 false branch)', async () => {
    const emptySummary: DashboardSummary = { ...SUMMARY, totalCustomers: 0, activeCount: 0 };
    const { component } = mount(storeMock({ summary$: of(emptySummary), kyc$: of(null) }));
    const kpis = await firstValueFrom(component.kpis$);
    // total === 0 → the activeRate ternary returns 0 instead of dividing by zero; missing KYC → 0/0.
    expect(kpis.totalCustomers).toBe(0);
    expect(kpis.activeRate).toBe(0);
    expect(kpis.verifiedCount).toBe(0);
    expect(kpis.kycTotal).toBe(0);
  });

  it('KPI derivation is safe when the summary is missing and KYC has no verified bucket', async () => {
    const kycWithoutVerified: KycDistribution = {
      total: 5,
      asOf: KYC.asOf,
      items: [{ status: 'PENDING', count: 5, percent: 100 }],
    };
    const { component } = mount(storeMock({ summary$: of(null), kyc$: of(kycWithoutVerified) }));
    const kpis = await firstValueFrom(component.kpis$);

    expect(kpis).toEqual({
      totalCustomers: 0,
      activeRate: 0,
      verifiedCount: 0,
      kycTotal: 5,
    });
  });

  it('volumeState$ surfaces the error (empty data) when /metrics/daily fails', async () => {
    const metrics = metricsMock();
    metrics.getDaily.mockReturnValueOnce(throwError(() => new Error('metrics down')));
    const { component } = mount(storeMock(), metrics);
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    expect(state.data).toEqual([]);
    expect(state.error).toBeInstanceOf(Error);
    expect(state.asOf).toBeNull();
  });

  it('volumeState$ coerces a non-numeric metric value to 0 (safeNumber guard)', async () => {
    const metrics = metricsMock();
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [
          { date: '2026-06-10', value: 'not-a-number' },
          { date: '2026-06-11', value: '5000' },
        ],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    );
    const { component } = mount(storeMock(), metrics);
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    // 'not-a-number' → 0, '5000' → 5000; the positive point keeps the series non-empty.
    expect(state.data.map(p => p.values[0])).toEqual([0, 5000]);
  });

  it('volumeState$ skips unparseable metric dates before plotting the valid buckets', async () => {
    const metrics = metricsMock();
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [
          { date: 'not-a-date', value: '999999' },
          { date: '2026-06-11', value: '5000' },
        ],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    );
    const { component } = mount(storeMock(), metrics);
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    expect(state.data.map(p => p.values[0])).toEqual([5000]);
  });

  it('the "day" range selection narrows the backend metric window (1-day bounds branch)', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockClear();
    metrics.getDaily.mockReturnValueOnce(
      of({
        metric: 'transactions_volume_minor_daily',
        items: [{ date: '2026-06-11', value: '125000' }],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    );

    component.onRangeChange('day');
    expect(component.range).toBe('day');
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    const args = metrics.getDaily.mock.calls.at(-1)?.[0] as { from: string; to: string };
    // day window = 1 calendar day → from === to (the metricBoundsForRange 'day' arm).
    expect(args.from).toBe(args.to);
  });

  it('falls back to the latest available daily bucket when the current day has no volume', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockReset();
    metrics.getDaily
      .mockReturnValueOnce(
        of({
          metric: 'transactions_volume_minor_daily',
          items: [],
          asOf: '2026-06-11T00:00:00.000Z',
        }),
      )
      .mockReturnValueOnce(
        of({
          metric: 'transactions_volume_minor_daily',
          items: [
            { date: '2026-06-09', value: '0' },
            { date: '2026-06-10', value: '125000' },
            { date: '2026-06-11', value: '150000' },
          ],
          asOf: '2026-06-11T12:00:00.000Z',
        }),
      );

    component.onRangeChange('day');
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    expect(metrics.getDaily).toHaveBeenCalledTimes(2);
    expect(state.data.map(p => p.values[0])).toEqual([150000]);
    expect(state.asOf).toBe('2026-06-11T12:00:00.000Z');
  });

  it('keeps the current-day empty metric when the weekly fallback also has no positive bucket', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockReset();
    metrics.getDaily
      .mockReturnValueOnce(
        of({
          metric: 'transactions_volume_minor_daily',
          items: [],
          asOf: '2026-06-11T00:00:00.000Z',
        }),
      )
      .mockReturnValueOnce(
        of({
          metric: 'transactions_volume_minor_daily',
          items: [
            { date: '2026-06-09', value: '0' },
            { date: '2026-06-10', value: '0' },
          ],
          asOf: '2026-06-10T12:00:00.000Z',
        }),
      );

    component.onRangeChange('day');
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    expect(metrics.getDaily).toHaveBeenCalledTimes(2);
    expect(state.data).toEqual([]);
    expect(state.asOf).toBe('2026-06-11T00:00:00.000Z');
  });

  it('keeps the current-day empty metric when the weekly fallback request fails', async () => {
    const { component, metrics } = mount(storeMock());
    await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));
    metrics.getDaily.mockReset();
    metrics.getDaily
      .mockReturnValueOnce(
        of({
          metric: 'transactions_volume_minor_daily',
          items: [],
          asOf: '2026-06-11T00:00:00.000Z',
        }),
      )
      .mockReturnValueOnce(throwError(() => new Error('fallback down')));

    component.onRangeChange('day');
    const state = await firstValueFrom(component.volumeState$.pipe(filter(s => !s.loading)));

    expect(metrics.getDaily).toHaveBeenCalledTimes(2);
    expect(state.data).toEqual([]);
    expect(state.asOf).toBe('2026-06-11T00:00:00.000Z');
  });

  it('falls back to neutral colour + default icon for an unmapped KYC status (presentational guards)', async () => {
    const oddKyc: KycDistribution = {
      total: 10,
      asOf: KYC.asOf,
      items: [{ status: 'MYSTERY_STATUS', count: 10, percent: 100 }],
    };
    const { component } = mount(storeMock({ kyc$: of(oddKyc) }));
    const rows = await firstValueFrom(component.breakdown$);
    // KYC_CHART_HUE / KYC_TILE_ICON have no entry → the `?? fallback` arms supply safe defaults.
    expect(rows[0].color).toBe('var(--color-chart-muted-from)');
    expect(rows[0].icon).toBe('ri-shield-line');
  });

  it('trackByBreakdown returns the row status as a stable @for key', () => {
    const { component } = mount(storeMock());
    expect(component.trackByBreakdown(0, { status: 'VERIFIED' } as never)).toBe('VERIFIED');
  });

  it('formatCount groups numbers by the active language locale (tr)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DashboardStatsStore, useValue: storeMock() },
        { provide: MetricsApi, useValue: metricsMock() },
        { provide: TranslateService, useValue: { currentLang: 'tr', instant: (k: string) => k } },
        { provide: DashboardStreamService, useValue: { connect: () => of() } },
      ],
    });
    const c = TestBed.runInInjectionContext(() => new AnalyticsComponent());
    expect(c.formatCount(1500)).toBe((1500).toLocaleString('tr-TR'));
  });
});
