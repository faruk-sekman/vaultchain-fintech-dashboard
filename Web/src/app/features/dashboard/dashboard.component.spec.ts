/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { formatDate } from '@angular/common';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { EMPTY, Subject, filter, firstValueFrom, of, throwError } from 'rxjs';
import { DashboardEvent } from '@core/api/dashboard.api';
import { DashboardComponent } from './dashboard.component';
import { DashboardStatsStore } from '@core/state/dashboard-metrics';
import { LatestCustomerStore } from '@features/dashboard/state';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { AuthService } from '@core/auth/auth.service';
import { DashboardSummary, KycDistribution } from '@core/api/dashboard.api';
import { MetricsApi } from '@core/api/metrics.api';
import { Customer } from '@shared/models/customer.model';

const SUMMARY: DashboardSummary = {
  totalCustomers: 960,
  activeCount: 820,
  inactiveCount: 140,
  activeRate: 85.4,
  inactiveRate: 14.6,
  ageStats: { avg: 34, min: 18, max: 71 },
  asOf: '2026-06-11T09:00:00Z',
};

const KYC: KycDistribution = {
  items: [
    { status: 'VERIFIED', count: 700, percent: 72.9 },
    { status: 'PENDING', count: 200, percent: 20.8 },
    { status: 'REJECTED', count: 0, percent: 0 },
  ],
  total: 960,
  asOf: '2026-06-11T09:00:00Z',
};

const RECENT: Customer[] = [
  {
    id: 'c-1',
    name: 'Ada Lovelace',
    email: 'a***@e***.com', // masked by the backend
    phone: '*** *** 4567',
    walletNumber: '',
    dateOfBirth: '',
    nationalId: '0930',
    address: { country: '', city: '', postalCode: '', line1: '' },
    kycStatus: 'VERIFIED',
    isActive: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-07T00:00:00.000Z',
  },
];

function createComponent(
  overrides: {
    summary?: DashboardSummary | null;
    kyc?: KycDistribution | null;
    recent?: Customer[];
    trendItems?: Array<{ date: string; value: string }>;
  } = {},
) {
  const statsStore = {
    summary$: of(overrides.summary ?? null),
    kyc$: of(overrides.kyc ?? null),
    loading$: of(false),
    error$: of(null),
    load: vi.fn(),
  };
  const latestStore = {
    latest$: of(null),
    loading$: of(false),
    loaded$: of(false),
    error$: of(null),
    recent$: of(overrides.recent ?? []),
    recentLoading$: of(false),
    recentLoaded$: of(false),
    recentError$: of(null),
    load: vi.fn(),
    loadRecent: vi.fn(),
  };
  const router = { navigate: vi.fn() };
  const metricsApi = {
    getDaily: vi.fn(() =>
      of({
        metric: 'customers_new_daily' as const,
        items: overrides.trendItems ?? [],
        asOf: '2026-06-11T12:00:00.000Z',
      }),
    ),
  };
  // `instant` echoes the key so mapping assertions stay deterministic.
  const i18n = {
    instant: (key: string) => key,
    onLangChange: new Subject(),
  } as unknown as TranslateService;
  const auth = { hasPermission: (p: string) => p === 'customers.manage' } as unknown as AuthService;
  // Realtime SSE stream is a no-op in unit tests (no live connection); ngOnInit just subscribes.
  const stream = { connect: vi.fn(() => EMPTY) };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DashboardStatsStore, useValue: statsStore },
      { provide: LatestCustomerStore, useValue: latestStore },
      { provide: MetricsApi, useValue: metricsApi },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: i18n },
      { provide: AuthService, useValue: auth },
      { provide: DashboardStreamService, useValue: stream },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new DashboardComponent());
  return { component, statsStore, latestStore, router, metricsApi };
}

/**
 * Builds a DashboardComponent with a specific active language so locale-sensitive formatting
 * (`formatCount`) can be asserted deterministically.
 */
function createComponentWithLang(currentLang: 'tr' | 'en' | undefined): DashboardComponent {
  const statsStore = {
    summary$: of(null),
    kyc$: of(null),
    loading$: of(false),
    error$: of(null),
    load: vi.fn(),
  };
  const latestStore = {
    recent$: of([]),
    recentLoading$: of(false),
    recentLoaded$: of(false),
    recentError$: of(null),
    load: vi.fn(),
    loadRecent: vi.fn(),
  };
  const i18n = {
    instant: (key: string) => key,
    currentLang,
    onLangChange: new Subject(),
  } as unknown as TranslateService;
  const auth = { hasPermission: () => false } as unknown as AuthService;
  const stream = { connect: vi.fn(() => EMPTY) };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DashboardStatsStore, useValue: statsStore },
      { provide: LatestCustomerStore, useValue: latestStore },
      { provide: MetricsApi, useValue: { getDaily: vi.fn(() => EMPTY) } },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: TranslateService, useValue: i18n },
      { provide: AuthService, useValue: auth },
      { provide: DashboardStreamService, useValue: stream },
    ],
  });
  return TestBed.runInInjectionContext(() => new DashboardComponent());
}

describe('DashboardComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ngOnInit loads the server aggregates + recent customers (no legacy latest fetch)', () => {
    const { component, statsStore, latestStore } = createComponent();
    component.ngOnInit();
    expect(statsStore.load).toHaveBeenCalledWith();
    expect(latestStore.loadRecent).toHaveBeenCalledWith();
    expect(latestStore.load).not.toHaveBeenCalled();
  });

  it('exposes the store streams', () => {
    const { component } = createComponent();
    expect(component.summary$).toBeDefined();
    expect(component.kyc$).toBeDefined();
    expect(component.recent$).toBeDefined();
  });

  it('kycLabelKey builds the i18n key for a backend status', () => {
    const { component } = createComponent();
    expect(component.kycLabelKey('NOT_STARTED')).toBe('dashboard.kyc.NOT_STARTED');
    expect(component.kycLabelKey('VERIFIED')).toBe('dashboard.kyc.VERIFIED');
  });

  it('kycBadgeColor maps KYC statuses through the shared single source of truth', () => {
    const { component } = createComponent();
    expect(component.kycBadgeColor('VERIFIED')).toBe('green');
    expect(component.kycBadgeColor('REJECTED')).toBe('red');
    expect(component.kycBadgeColor('SOMETHING_UNMAPPED')).toBe('zinc');
  });

  it('reload handlers re-dispatch the region loads (retry)', () => {
    const { component, statsStore, latestStore } = createComponent();
    component.reloadStats();
    component.reloadRecent();
    expect(statsStore.load).toHaveBeenCalledWith();
    expect(latestStore.loadRecent).toHaveBeenCalledWith();
  });

  it('falls back to a null error stream when the store omits error$ (lean test doubles)', () => {
    const { component } = createComponent();
    expect(component.statsError$).toBeDefined();
    expect(component.recentError$).toBeDefined();
  });

  it('emits null from the fallback error streams when BOTH stores omit error$ (?? of(null) branch)', async () => {
    // Lean doubles WITHOUT `error$` / `recentError$` exercise the `?? of(null)` fallbacks (lines 171/177),
    // which the default createComponent (which always supplies error$) never reaches.
    const statsStore = { summary$: of(null), kyc$: of(null), loading$: of(false), load: vi.fn() };
    const latestStore = {
      recent$: of([]),
      recentLoading$: of(false),
      recentLoaded$: of(false),
      load: vi.fn(),
      loadRecent: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DashboardStatsStore, useValue: statsStore },
        { provide: LatestCustomerStore, useValue: latestStore },
        { provide: MetricsApi, useValue: { getDaily: vi.fn(() => EMPTY) } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: TranslateService,
          useValue: {
            instant: (k: string) => k,
            onLangChange: new Subject(),
          } as unknown as TranslateService,
        },
        {
          provide: AuthService,
          useValue: { hasPermission: () => false } as unknown as AuthService,
        },
        { provide: DashboardStreamService, useValue: { connect: vi.fn(() => EMPTY) } },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    expect(await firstValueFrom(component.statsError$)).toBeNull();
    expect(await firstValueFrom(component.recentError$)).toBeNull();
  });

  it('re-pulls the aggregates + recent list on an SSE customer mutation (debounced)', () => {
    vi.useFakeTimers();
    const stream$ = new Subject<DashboardEvent>();
    const statsStore = {
      summary$: of(null),
      kyc$: of(null),
      loading$: of(false),
      error$: of(null),
      load: vi.fn(),
    };
    const latestStore = {
      recent$: of([]),
      recentLoading$: of(false),
      recentLoaded$: of(false),
      recentError$: of(null),
      load: vi.fn(),
      loadRecent: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DashboardStatsStore, useValue: statsStore },
        { provide: LatestCustomerStore, useValue: latestStore },
        { provide: MetricsApi, useValue: { getDaily: vi.fn(() => EMPTY) } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: TranslateService,
          useValue: {
            instant: (k: string) => k,
            onLangChange: new Subject(),
          } as unknown as TranslateService,
        },
        {
          provide: AuthService,
          useValue: { hasPermission: () => false } as unknown as AuthService,
        },
        { provide: DashboardStreamService, useValue: { connect: vi.fn(() => stream$) } },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    component.ngOnInit();
    expect(statsStore.load).toHaveBeenCalledTimes(1); // initial
    expect(latestStore.loadRecent).toHaveBeenCalledTimes(1);

    // A mutation elsewhere pushes a PII-free signal → debounced re-pull of BOTH regions (lines 231-232).
    stream$.next({ type: 'customer.created', customerId: 'c-1', at: '2026-06-18T00:00:00.000Z' });
    vi.advanceTimersByTime(300);
    expect(statsStore.load).toHaveBeenCalledTimes(2);
    expect(latestStore.loadRecent).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reloadTrend re-dispatches the trend metric load (retry)', async () => {
    const { component, metricsApi } = createComponent({
      trendItems: [{ date: '2026-06-10', value: '5' }],
    });
    await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));
    metricsApi.getDaily.mockClear();
    component.reloadTrend();
    await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));
    expect(metricsApi.getDaily).toHaveBeenCalled();
  });

  it('trendState$ surfaces the error (empty data) when /metrics/daily fails', async () => {
    const { component, metricsApi } = createComponent();
    metricsApi.getDaily.mockReturnValue(throwError(() => new Error('metrics down')));
    component.reloadTrend(); // re-run with the failing source so the catchError branch (line 210) fires

    const state = await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));
    expect(state.data).toEqual([]);
    expect(state.error).toBeInstanceOf(Error);
  });

  it('trendState$ coerces a non-numeric metric value to 0 (safeNumber guard) → still no positive data', async () => {
    const { component } = createComponent({
      trendItems: [
        { date: '2026-06-10', value: 'not-a-number' },
        { date: '2026-06-11', value: '0' },
      ],
    });
    const state = await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));
    // 'not-a-number' → 0 (safeNumber non-finite branch, line 395) and 0 → 0, so the panel reads empty.
    expect(state.data).toEqual([]);
  });

  it('kycHero$ is null when the distribution is missing (hero renders its empty state)', async () => {
    const hero = await firstValueFrom(createComponent({ kyc: null }).component.kycHero$);
    expect(hero).toBeNull();
  });

  // ── v2.1 row 1: hero cards carry the REAL aggregates ───────────────────────

  it('overviewHero$ maps the summary into the overview hero (total + aktif/pasif meta + ratio line)', async () => {
    const { component } = createComponent({ summary: SUMMARY });
    const hero = await firstValueFrom(component.overviewHero$);

    expect(hero).not.toBeNull();
    // No `currentLang` on the lean i18n double → formatCount falls back to en-US grouping.
    expect(hero?.value).toBe((960).toLocaleString('en-US'));
    expect(hero?.meta).toEqual([
      { label: 'dashboard.labels.active', value: (820).toLocaleString('en-US') },
      { label: 'dashboard.labels.inactive', value: (140).toLocaleString('en-US') },
    ]);
    expect(hero?.ratioLine).toBe('85.4% dashboard.labels.active · 14.6% dashboard.labels.inactive');
  });

  it('normalizes an empty/malformed summary so dashboard cards never render NaN or undefined%', async () => {
    const malformedSummary = {
      totalCustomers: undefined,
      activeCount: undefined,
      inactiveCount: undefined,
      activeRate: undefined,
      inactiveRate: undefined,
      ageStats: { avg: undefined, min: null, max: null },
      asOf: '',
    } as unknown as DashboardSummary;
    const { component } = createComponent({ summary: malformedSummary });
    const hero = await firstValueFrom(component.overviewHero$);

    expect(hero?.value).toBe('0');
    expect(hero?.meta).toEqual([
      { label: 'dashboard.labels.active', value: '0' },
      { label: 'dashboard.labels.inactive', value: '0' },
    ]);
    expect(hero?.segments.map(segment => segment.pct)).toEqual([0, 0]);
    expect(hero?.ratioLine).toBe('0% dashboard.labels.active · 0% dashboard.labels.inactive');
    expect(component.formatPercent(malformedSummary.activeRate)).toBe('0%');
    expect(
      component.formatAverageAge(malformedSummary.ageStats?.avg, 'dashboard.labels.years'),
    ).toBeNull();
  });

  it('format helpers clamp non-finite counts, percents, and average age values', () => {
    const { component } = createComponent();

    expect(component.formatCount(Number.NaN)).toBe('0');
    expect(component.formatPercent(Number.NaN)).toBe('0%');
    expect(component.formatPercent(150)).toBe('100%');
    expect(component.formatAverageAge(34, 'dashboard.labels.years')).toBe(
      '34 dashboard.labels.years',
    );
    expect(
      component.formatAverageAge(Number.POSITIVE_INFINITY, 'dashboard.labels.years'),
    ).toBeNull();
  });

  it('derives overview rates from counts when the API omits rate fields', async () => {
    const summaryWithoutRates = {
      ...SUMMARY,
      totalCustomers: 10,
      activeCount: 7,
      inactiveCount: 3,
      activeRate: null,
      inactiveRate: null,
    } as unknown as DashboardSummary;
    const { component } = createComponent({ summary: summaryWithoutRates });
    const hero = await firstValueFrom(component.overviewHero$);

    expect(hero?.segments.map(segment => segment.pct)).toEqual([70, 30]);
    expect(hero?.ratioLine).toBe('70% dashboard.labels.active · 30% dashboard.labels.inactive');
  });

  it('overviewHero$ is null without a summary (hero renders its em-dash empty state)', async () => {
    const hero = await firstValueFrom(createComponent().component.overviewHero$);
    expect(hero).toBeNull();
  });

  it('B1: rebuilds the hero labels when the language changes (no frozen instant() labels)', () => {
    // A language-aware i18n double: instant() output flips with `lang`, and onLangChange drives
    // the component's lang$ recombination — exactly what a real TR<->EN switch does.
    let lang = 'en';
    const onLangChange = new Subject<unknown>();
    const i18n = {
      instant: (key: string) => `${lang}:${key}`,
      onLangChange,
    } as unknown as TranslateService;

    const statsStore = {
      summary$: of(SUMMARY),
      kyc$: of(null),
      loading$: of(false),
      error$: of(null),
      load: vi.fn(),
    };
    const latestStore = {
      recent$: of([]),
      recentLoading$: of(false),
      recentLoaded$: of(true),
      recentError$: of(null),
      load: vi.fn(),
      loadRecent: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DashboardStatsStore, useValue: statsStore },
        { provide: LatestCustomerStore, useValue: latestStore },
        { provide: MetricsApi, useValue: { getDaily: vi.fn(() => EMPTY) } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: TranslateService, useValue: i18n },
        {
          provide: AuthService,
          useValue: { hasPermission: () => false } as unknown as AuthService,
        },
        { provide: DashboardStreamService, useValue: { connect: vi.fn(() => EMPTY) } },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());

    const emissions: (string | undefined)[] = [];
    const sub = component.overviewHero$.subscribe(hero => emissions.push(hero?.meta[0]?.label));

    expect(emissions.at(-1)).toBe('en:dashboard.labels.active');

    // Switch the language: the SAME summary must re-map with the new language's labels.
    lang = 'tr';
    onLangChange.next({ lang: 'tr' });
    expect(emissions.at(-1)).toBe('tr:dashboard.labels.active');
    sub.unsubscribe();
  });

  it('kycHero$ maps the distribution into the outline hero (VERIFIED count + verified-share meta + asOf)', async () => {
    const { component } = createComponent({ kyc: KYC });
    const hero = await firstValueFrom(component.kycHero$);

    expect(hero?.value).toBe((700).toLocaleString('en-US'));
    // The KYC ring was dropped (G7: the Row-2 bar is the one KYC chart); the verified share now
    // rides as a plain meta value ahead of the freshness stamp.
    expect(hero?.meta).toEqual([
      { label: 'dashboard.hero.verifiedShare', value: '72.9%' },
      { label: 'dashboard.asOf', value: formatDate(KYC.asOf, 'shortDate', 'en-US') },
    ]);
    expect(hero?.share).toBe(72.9);
  });

  it('normalizes an empty/malformed KYC payload without throwing or rendering NaN', async () => {
    const malformedKyc = [] as unknown as KycDistribution;
    const { component } = createComponent({ kyc: malformedKyc });

    const hero = await firstValueFrom(component.kycHero$);
    const bar = await firstValueFrom(component.kycBar$);

    expect(hero?.value).toBe('0');
    expect(hero?.share).toBe(0);
    expect(hero?.meta).toEqual([
      { label: 'dashboard.hero.verifiedShare', value: '0%' },
      { label: 'dashboard.asOf', value: '—' },
    ]);
    expect(bar).toEqual({ data: [], series: [] });
  });

  it('kycHero$ shows 0 / 0% when no VERIFIED bucket exists (real data, honest zero)', async () => {
    const { component } = createComponent({
      kyc: { items: [{ status: 'PENDING', count: 5, percent: 100 }], total: 5, asOf: KYC.asOf },
    });
    const hero = await firstValueFrom(component.kycHero$);
    expect(hero?.value).toBe('0');
    expect(hero?.share).toBe(0);
    // The honest zero shows in both the value and the verified-share meta pair.
    expect(hero?.meta).toEqual([
      { label: 'dashboard.hero.verifiedShare', value: '0%' },
      { label: 'dashboard.asOf', value: formatDate(KYC.asOf, 'shortDate', 'en-US') },
    ]);
  });

  // ── formatCount groups numbers in the ACTIVE locale ─────────

  it('formatCount groups in tr-TR when the active language is Turkish (1.500, matching the pipes)', () => {
    const component = createComponentWithLang('tr');
    expect(component.formatCount(1500)).toBe((1500).toLocaleString('tr-TR'));
    expect((1500).toLocaleString('tr-TR')).toBe('1.500');
  });

  it('formatCount groups in en-US when the active language is English (1,500)', () => {
    const component = createComponentWithLang('en');
    expect(component.formatCount(1500)).toBe((1500).toLocaleString('en-US'));
    expect((1500).toLocaleString('en-US')).toBe('1,500');
  });

  it('formatCount falls back to en-US grouping when no language is set', () => {
    const component = createComponentWithLang(undefined);
    expect(component.formatCount(1500)).toBe((1500).toLocaleString('en-US'));
  });

  it('feeds the KPI stat-card strip the locale-grouped count (1,500 / 1,260), matching the hero — not raw 1500', () => {
    // Regression: the top stat-card strip bound RAW numbers
    // (`[value]="vm.totalCustomers"` → "1500"), diverging from the hero/donut which group
    // ("1,500") on the same screen. The strip now binds `[value]="formatCount(vm.totalCustomers)"`
    // / `formatCount(vm.activeCount)` — the SAME formatter the hero uses. Asserting that formatter
    // here pins the value the stat-card paints. (The component template uses `templateUrl`, which
    // this no-plugin vitest env can't inline for DOM rendering, so — like every other spec in the
    // repo — we assert the binding's input rather than the painted node.)
    const en = createComponentWithLang('en');
    expect(en.formatCount(1500)).toBe('1,500'); // total customers KPI binding output
    expect(en.formatCount(1260)).toBe('1,260'); // active customers KPI binding output
    expect(en.formatCount(1500)).not.toBe('1500'); // the old, ungrouped residual is gone

    // TR groups with a dot, matching the hero/donut on the Turkish screen.
    const tr = createComponentWithLang('tr');
    expect(tr.formatCount(1500)).toBe('1.500');

    // Sub-1000 counts are never separated (e.g. the avg-age / small-count case) — correct in both locales.
    expect(en.formatCount(240)).toBe('240');
    expect(tr.formatCount(240)).toBe('240');
  });

  // ── v2.1 row 2: full-width KYC distribution bar (6 statuses, zero counts included) ──

  it('kycBar$ renders all 6 lifecycle statuses in canonical order with zero fills', async () => {
    const { component } = createComponent({ kyc: KYC });
    const bar = await firstValueFrom(component.kycBar$);

    // Each bar now carries its per-status hue (KYC_STATUS_HUE) alongside the count.
    expect(bar.data).toEqual([
      { label: 'dashboard.kyc.NOT_STARTED', values: [0], color: 'var(--chart-5)' },
      { label: 'dashboard.kyc.PENDING', values: [200], color: 'var(--chart-7)' },
      { label: 'dashboard.kyc.IN_REVIEW', values: [0], color: 'var(--chart-6)' },
      { label: 'dashboard.kyc.VERIFIED', values: [700], color: 'var(--color-success)' },
      { label: 'dashboard.kyc.REJECTED', values: [0], color: 'var(--color-danger)' },
      { label: 'dashboard.kyc.EXPIRED', values: [0], color: 'var(--color-warning)' },
    ]);
    expect(bar.series.map(s => s.name)).toEqual(['customers.title']);
  });

  it('kycBar$ is empty (honest) when the distribution is missing or all-zero', async () => {
    const missing = await firstValueFrom(createComponent().component.kycBar$);
    expect(missing).toEqual({ data: [], series: [] });

    const zero = await firstValueFrom(
      createComponent({ kyc: { items: [], total: 0, asOf: '' } }).component.kycBar$,
    );
    expect(zero).toEqual({ data: [], series: [] });
  });

  // ── v2.1 row 1 right: recent customers stream (masked as delivered) ────────

  it('recent$ exposes the masked recent customers from the store', async () => {
    const { component } = createComponent({ recent: RECENT });
    const recent = await firstValueFrom(component.recent$);
    expect(recent).toEqual(RECENT);
    expect(recent[0].email).toContain('***'); // masking preserved end-to-end
  });

  // ── v2.1 row 3: backend trend + REAL quick actions only ───────────────────

  it('trendState$ loads customer trend from /metrics/daily instead of a static series', async () => {
    const { component, metricsApi } = createComponent({
      summary: SUMMARY,
      kyc: KYC,
      trendItems: [
        { date: '2026-06-10', value: '2' },
        { date: '2026-06-11', value: '4' },
      ],
    });
    const state = await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));

    expect(metricsApi.getDaily).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'customers_new_daily' }),
    );
    expect(state.data.map(p => p.values[0])).toEqual([2, 4]);
  });

  it('trendState$ treats zero-only metrics as no data for the customer trend panel', async () => {
    const { component } = createComponent({
      trendItems: [
        { date: '2026-06-10', value: '0' },
        { date: '2026-06-11', value: '0' },
      ],
    });

    const state = await firstValueFrom(component.trendState$.pipe(filter(s => !s.loading)));

    expect(state.data).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('quick actions navigate to REAL routes only (customer create + analytics + customers list)', () => {
    const { component, router } = createComponent();

    component.goToCreateCustomer();
    expect(router.navigate).toHaveBeenCalledWith(['/customers/new']);

    component.goToAnalytics();
    expect(router.navigate).toHaveBeenCalledWith(['/analytics']);

    component.goToCustomers();
    expect(router.navigate).toHaveBeenCalledWith(['/customers']);
    expect(router.navigate).toHaveBeenCalledTimes(3);
  });

  it('exposes no fabricated system-users roster', () => {
    const { component } = createComponent();
    expect((component as unknown as Record<string, unknown>)['internalUsers']).toBeUndefined();
  });
});
