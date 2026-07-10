/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ValueSwapDirective } from '@shared/directives/value-swap.directive';

export type UiStatAccent = 'indigo' | 'blue' | 'teal' | 'green' | 'amber' | 'red' | 'violet';
/** v2 §4 icon-tile tone — maps onto the `--tile-*` soft backgrounds. */
export type UiStatTone = 'blue' | 'yellow' | 'teal' | 'pink';
/** v2.1 §3.3 G2 layout — `pill` is the horizontal compact KPI form for overview rows. */
export type UiStatLayout = 'default' | 'pill';
export type UiStatDeltaDirection = 'up' | 'down';

export interface UiStatDelta {
  /** Magnitude shown next to the arrow (already the number to display, e.g. 8 → "8%"). */
  value: number;
  direction: UiStatDeltaDirection;
  /** Optional already-translated suffix line, e.g. "vs last week". */
  label?: string | null;
}

/** Maps each accent to its badge color family (chip) and chart hue index (sparkline/glow). */
interface AccentTokens {
  readonly badge: string;
  readonly chart: number;
}

const ACCENT_TOKENS: Record<UiStatAccent, AccentTokens> = {
  indigo: { badge: 'indigo', chart: 1 },
  blue: { badge: 'blue', chart: 2 },
  teal: { badge: 'teal', chart: 3 },
  green: { badge: 'green', chart: 4 },
  amber: { badge: 'yellow', chart: 5 },
  red: { badge: 'red', chart: 6 },
  violet: { badge: 'purple', chart: 7 },
};

/** v2 §4: tile background + matching accent glyph colour per tone (tokens only). */
const TONE_TOKENS: Record<UiStatTone, { readonly bg: string; readonly icon: string }> = {
  blue: { bg: 'var(--tile-blue)', icon: 'var(--color-link)' },
  yellow: { bg: 'var(--tile-yellow)', icon: 'var(--color-accent-yellow)' },
  teal: { bg: 'var(--tile-teal)', icon: 'var(--color-accent-teal)' },
  pink: { bg: 'var(--tile-pink)', icon: 'var(--color-danger)' },
};

/** Sparkline viewBox geometry (§6.4 — ~64×28, no axes/labels). */
const SPARK_W = 64;
const SPARK_H = 28;
const SPARK_PAD = 2;

/**
 * Stat / KPI card — the canonical dashboard tile (design-system-ui-kit.md §5.13).
 *
 * Anatomy: tinted icon chip · label · value (tabular nums) · optional delta
 * (▲ up = success / ▼ down = danger, with a text alternative) · optional inline
 * SVG sparkline (§6.4) · loading skeleton · empty (`—`) state. An optional
 * `href` turns the whole tile into a link.
 *
 * The sparkline SVG is rendered inline here (no dependency on another chart
 * component, per the build contract). It is `aria-hidden` because the value +
 * delta already carry the accessible meaning; a `<title>` summarises the trend.
 */
@Component({
  selector: 'app-ui-stat-card',
  standalone: true,
  imports: [CommonModule, ValueSwapDirective],
  templateUrl: './ui-stat-card.component.html',
  styleUrl: './ui-stat-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiStatCardComponent {
  /** Already-translated label (e.g. "Total customers"). */
  readonly label = input('');
  /** Pre-formatted value (currency / percentage / count). */
  readonly value = input<string | number | null>(null);
  /** RemixIcon class for the chip glyph (e.g. `ri-group-line`). */
  readonly icon = input('');
  readonly accent = input<UiStatAccent>('indigo');
  /**
   * ADDITIVE (v2 §4): icon-tile tone. When set, the chip renders as a `--tile-*`
   * soft tile with the matching accent glyph; `accent` keeps driving the sparkline.
   * Default `null` preserves the legacy badge-derived chip exactly.
   */
  readonly tone = input<UiStatTone | null>(null);
  /**
   * ADDITIVE (v2.1 §3.3 G2): `pill` renders the horizontal compact KPI form —
   * icon tile (~60px) LEFT, label over value RIGHT, host height ≈112px.
   * Default `'default'` keeps the stacked v2 card exactly (zero visual drift).
   */
  readonly layout = input<UiStatLayout>('default');
  readonly delta = input<UiStatDelta | null>(null);
  /** Sparkline data points (optional); needs ≥2 points to render. */
  readonly trend = input<number[] | null>(null);
  /** Already-translated text alternative summarising the trend (sparkline <title>). */
  readonly trendLabel = input<string | null>(null);
  /** Already-translated accessible sentence for the delta, e.g. "increased 8 percent". */
  readonly deltaLabel = input<string | null>(null);
  readonly loading = input(false);
  /** When set, the whole tile becomes an `<a>` link. */
  readonly href = input<string | null>(null);
  /** Accessible name for the link wrapper; defaults to the label. */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);

  readonly sparkWidth = SPARK_W;
  readonly sparkHeight = SPARK_H;

  /** Empty when not loading and no value was provided. */
  get isEmpty(): boolean {
    const value = this.value();
    return !this.loading() && (value === null || value === '');
  }

  get chipBg(): string {
    const tone = this.tone();
    if (tone) return TONE_TOKENS[tone].bg;
    return `var(--badge-${ACCENT_TOKENS[this.accent()].badge}-bg)`;
  }

  get chipText(): string {
    const tone = this.tone();
    if (tone) return TONE_TOKENS[tone].icon;
    return `var(--badge-${ACCENT_TOKENS[this.accent()].badge}-text)`;
  }

  get accentColor(): string {
    return `var(--chart-${ACCENT_TOKENS[this.accent()].chart})`;
  }

  /** Custom properties forwarded to the host so chip + sparkline pick up the accent. */
  get accentStyles(): Record<string, string> {
    return {
      '--stat-chip-bg': this.chipBg,
      '--stat-chip-text': this.chipText,
      '--stat-accent': this.accentColor,
    };
  }

  get hasTrend(): boolean {
    const trend = this.trend();
    return Array.isArray(trend) && trend.length >= 2;
  }

  /** Polyline points for the sparkline, normalised into the padded viewBox. */
  get sparkPoints(): string {
    if (!this.hasTrend) return '';
    const data = this.trend() as number[];
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const innerW = SPARK_W - SPARK_PAD * 2;
    const innerH = SPARK_H - SPARK_PAD * 2;
    const step = innerW / (data.length - 1);
    return data
      .map((d, i) => {
        const x = SPARK_PAD + i * step;
        const y = SPARK_PAD + innerH - ((d - min) / span) * innerH;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  /** The last point coordinate (rendered as the trailing dot per §6.4). */
  get sparkLastPoint(): { x: number; y: number } | null {
    if (!this.hasTrend) return null;
    const pts = this.sparkPoints.split(' ');
    const last = pts[pts.length - 1];
    const [x, y] = last.split(',').map(Number);
    return { x, y };
  }

  /** Area-fill path: the line points plus a baseline close, for the faint gradient. */
  get sparkAreaPath(): string {
    if (!this.hasTrend) return '';
    const baseline = SPARK_H - SPARK_PAD;
    const pts = this.sparkPoints.split(' ');
    const firstX = pts[0].split(',')[0];
    const lastX = pts[pts.length - 1].split(',')[0];
    return `M ${firstX},${baseline} L ${pts.join(' L ')} L ${lastX},${baseline} Z`;
  }

  /** v2 §4 "+x%" badge text: sign from direction, magnitude from |value| (never colour-only). */
  get deltaDisplay(): string {
    const delta = this.delta();
    if (!delta) return '';
    const sign = delta.direction === 'up' ? '+' : '-';
    return `${sign}${Math.abs(delta.value)}%`;
  }

  /** Accessible delta sentence; falls back to a plain composed string. */
  get deltaAccessibleText(): string {
    const delta = this.delta();
    if (!delta) return '';
    const deltaLabel = this.deltaLabel();
    if (deltaLabel) return deltaLabel;
    const verb = delta.direction === 'up' ? 'increased' : 'decreased';
    return `${verb} ${delta.value}`;
  }

  get linkAccessibleName(): string | null {
    return this.ariaLabel() ?? this.label() ?? null;
  }
}
