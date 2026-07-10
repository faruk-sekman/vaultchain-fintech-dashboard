/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Vertical bar chart (design-system-ui-kit.md §5.27 / §6.5). Pure inline SVG — NO
 * chart library, NO canvas (build contract §6.1). Supports single- and grouped
 * (e.g. target-vs-reality) series; colours come from `--chart-1..8`. The SVG is
 * `aria-hidden`; the data is carried by a visually-hidden table (§6.9).
 */
import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import {
  UiChartTipComponent,
  UiChartTipRow,
} from '@shared/components/ui-chart-tip/ui-chart-tip.component';

/** One category along the x-axis. `values[i]` aligns with `series[i]`. */
export interface UiChartBarDatum {
  /** Already-translated category label. */
  label: string;
  /** One value per series (single-series charts pass a one-element array). */
  values: number[];
  /** Optional per-category colour (single-series only) — overrides the series palette hue. */
  color?: string;
}

/** A named series (drives legend + colour). */
export interface UiChartBarSeries {
  /** Already-translated series name. */
  name: string;
  /** Optional explicit colour; palette is used otherwise. */
  color?: string;
}

/** A positioned rectangle ready to render. */
export interface UiChartBarRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly seriesIndex: number;
  readonly seriesName: string;
  readonly categoryLabel: string;
  readonly value: number;
  /** Unique id for this bar's `<linearGradient>` (gradient mode only). */
  readonly gradId: string;
}

/** A positioned category tick. */
export interface UiChartBarTick {
  readonly label: string;
  /** Centre x of the category group, in viewBox units. */
  readonly x: number;
}

/** A horizontal gridline. */
export interface UiChartBarGrid {
  readonly y: number;
  /** Formatted axis value at this line. */
  readonly label: string;
}

/** A resolved legend entry. */
export interface UiChartBarLegendItem {
  readonly name: string;
  readonly color: string;
}

const VB_W = 320;
const VB_H = 200;
const PAD_TOP = 8;
const PAD_BOTTOM = 24; // room for category labels
const PAD_LEFT = 4;
const PAD_RIGHT = 4;
const GRID_LINES = 4;
const GROUP_GAP_RATIO = 0.32; // gap between categories ≈ 32% (§6.5)
const BAR_GAP_RATIO = 0.16; // gap between bars within a group
/** v2 §4: slim capsule bars (~15px) — cap the computed width in viewBox units. */
const MAX_BAR_WIDTH = 15;
/** Beyond this many categories the x labels are thinned so they never overlap. */
const MAX_TICK_LABELS = 8;

let uiBarSeq = 0;

@Component({
  selector: 'app-ui-chart-bar',
  standalone: true,
  imports: [CommonModule, UiChartTipComponent],
  templateUrl: './ui-chart-bar.component.html',
  styleUrl: './ui-chart-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiChartBarComponent {
  /** Categories with one value per series. */
  @Input() data: ReadonlyArray<UiChartBarDatum> = [];
  /** Series metadata; when omitted a single unnamed series is assumed. */
  @Input() series: ReadonlyArray<UiChartBarSeries> = [];
  /** Formats axis + table values. Defaults to a localized integer. */
  /** B2: default value formatting follows the ACTIVE UI language via the central service. */
  private readonly fmt = inject(LocaleFormatService);
  @Input() formatVal: (value: number) => string = v => this.fmt.number(v);
  /** Already-translated accessible summary (SVG `<title>` + table caption fallback). */
  @Input() ariaLabel: string | null = null;
  /** Already-translated header for the visually-hidden data table. */
  @Input() tableCaption: string | null = null;
  /** Already-translated "No data" empty-state label. */
  @Input() noDataLabel = 'No data';
  /** Already-translated table column header for the category. */
  @Input() categoryLabel = 'Category';
  /** Already-translated table column header for the value (single-series only). */
  @Input() valueLabel = 'Value';
  /** Whether to render the legend (only meaningful for ≥1 named series). */
  @Input() legend = true;
  /**
   * ADDITIVE (v2.1 §4 / G5): full chart furniture — ~5 horizontal 1px gridlines,
   * a nice-rounded numeric y-axis (0..max) on the left, x category labels and
   * the top-right legend; the plot area stretches to the host height
   * (consumers size the card). `false` keeps the legacy quiet grid exactly.
   */
  @Input() furniture = true;
  /**
   * Opt-in: fill each bar with a vertical two-tone gradient of its series hue (lighter top →
   * full bottom) for a more dimensional, "designed" look. Default `false` keeps flat bars.
   */
  @Input() gradient = false;
  /** Opt-in: render each bar's value as a label above it (HTML overlay — never distorts). */
  @Input() valueLabels = false;
  /** SVG height in px — the plot's MINIMUM height; the plot grows with the host. */
  @Input() height = 240;
  @Input() loading = false;
  @Input() id: string | null = null;

  readonly viewBoxW = VB_W;
  readonly viewBoxH = VB_H;
  private readonly seq = uiBarSeq++;

  /** Hovered category label (drives the per-bar darken) + the chic tooltip, set on plot mousemove. */
  hoverLabel: string | null = null;
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

  /** Pointer over the plot → snap to the nearest category column and surface its tooltip at the cursor. */
  onMove(event: MouseEvent): void {
    const rect = (event.currentTarget as SVGGraphicsElement).getBoundingClientRect();
    const cats = this.usable;
    if (cats.length === 0 || rect.width === 0) return;
    const relX = (event.clientX - rect.left) / rect.width;
    const plotW = VB_W - PAD_LEFT - PAD_RIGHT;
    const frac = (relX * VB_W - PAD_LEFT) / plotW;
    const i = Math.max(0, Math.min(cats.length - 1, Math.floor(frac * cats.length)));
    const cat = cats[i];
    this.hoverLabel = cat.label;
    const cols = this.series.length ? this.series : [{ name: '' }];
    const rows: UiChartTipRow[] = cols.map((s, si) => ({
      label: s.name || this.valueLabel,
      value: this.formatVal(cat.values[si] ?? 0),
    }));
    this.tip = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      color: this.seriesCount === 1 && cat.color ? cat.color : this.seriesColor(0),
      title: cat.label,
      rows,
    };
  }

  onLeave(): void {
    this.hoverLabel = null;
    this.tip = { ...this.tip, visible: false };
  }

  private get usable(): ReadonlyArray<UiChartBarDatum> {
    return this.data.filter(d => Array.isArray(d.values) && d.values.length > 0);
  }

  /** Series count = max value-array length across categories (≥1). */
  private get seriesCount(): number {
    const fromData = this.usable.reduce((max, d) => Math.max(max, d.values.length), 0);
    return Math.max(fromData, this.series.length, 1);
  }

  private seriesColor(index: number): string {
    const explicit = this.series[index]?.color;
    if (explicit) return explicit;
    // v2 §4: series A = --chart-1, series B = --color-accent-teal; rest from the palette.
    if (index === 1) return 'var(--color-accent-teal)';
    return `var(--chart-${(index % 8) + 1})`;
  }

  /** Largest value across all bars; the y-axis tops out here (0-baseline, §6.5). */
  get maxValue(): number {
    let max = 0;
    for (const d of this.usable) {
      for (const v of d.values) {
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    return max;
  }

  get isEmpty(): boolean {
    return !this.loading && (this.usable.length === 0 || this.maxValue <= 0);
  }

  /** v2.1 G5: nice axis step (1/2/5 × 10^k, nearest) targeting ~GRID_LINES segments. */
  private get axisStep(): number {
    const max = this.maxValue;
    if (max <= 0) return 0;
    const rough = max / GRID_LINES;
    const base = 10 ** Math.floor(Math.log10(rough));
    const f = rough / base;
    const nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    return nf * base;
  }

  /**
   * Top of the y scale: with furniture the max is nice-rounded UP to a step
   * multiple (so the top gridline sits at/above the tallest bar); without
   * furniture the legacy raw max keeps the v2.0 geometry identical.
   */
  get scaleMax(): number {
    const max = this.maxValue;
    if (max <= 0) return 0;
    if (!this.furniture) return max;
    const step = this.axisStep;
    return Number((Math.ceil(max / step - 1e-9) * step).toFixed(6));
  }

  get hasLegend(): boolean {
    return this.legend && this.series.some(s => !!s.name);
  }

  get legendItems(): UiChartBarLegendItem[] {
    return this.series.map((s, i) => ({ name: s.name, color: s.color ?? this.seriesColor(i) }));
  }

  /** Horizontal gridlines + their axis values (top → 0 baseline). */
  get gridLines(): UiChartBarGrid[] {
    const top = this.scaleMax;
    if (top <= 0) return [];
    const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
    const lines: UiChartBarGrid[] = [];
    if (this.furniture) {
      // v2.1 G5: one line per nice step → labels are exact 0..max scale values.
      const step = this.axisStep;
      const count = Math.max(1, Math.round(top / step));
      for (let i = 0; i <= count; i++) {
        const value = Number((step * (count - i)).toFixed(6));
        lines.push({ y: PAD_TOP + plotH * (i / count), label: this.formatVal(value) });
      }
    } else {
      for (let i = 0; i <= GRID_LINES; i++) {
        const ratio = i / GRID_LINES;
        lines.push({
          y: PAD_TOP + plotH * ratio,
          label: this.formatVal(Math.round(top * (1 - ratio))),
        });
      }
    }
    return lines;
  }

  /** All bar rectangles, grouped per category (heights scale against the axis top). */
  get bars(): UiChartBarRect[] {
    const cats = this.usable;
    const max = this.scaleMax;
    if (cats.length === 0 || max <= 0) return [];

    const plotW = VB_W - PAD_LEFT - PAD_RIGHT;
    const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
    const baseline = PAD_TOP + plotH;
    const groupWidth = plotW / cats.length;
    const groupGap = groupWidth * GROUP_GAP_RATIO;
    const innerWidth = groupWidth - groupGap;
    const n = this.seriesCount;
    const barGap = n > 1 ? (innerWidth * BAR_GAP_RATIO) / n : 0;
    // v2 §4: cap to slim capsules and re-centre the (narrower) group.
    const barWidth = Math.min((innerWidth - barGap * (n - 1)) / n, MAX_BAR_WIDTH);
    const usedWidth = barWidth * n + barGap * (n - 1);
    const centreOffset = Math.max(0, (innerWidth - usedWidth) / 2);

    const rects: UiChartBarRect[] = [];
    cats.forEach((cat, ci) => {
      const groupX = PAD_LEFT + groupWidth * ci + groupGap / 2 + centreOffset;
      for (let si = 0; si < n; si++) {
        const value = cat.values[si] ?? 0;
        const h = value > 0 ? (value / max) * plotH : 0;
        // Single-series charts may colour each category individually (e.g. KYC status hues).
        const color = n === 1 && cat.color ? cat.color : this.seriesColor(si);
        rects.push({
          x: groupX + si * (barWidth + barGap),
          y: baseline - h,
          width: barWidth,
          height: h,
          color,
          seriesIndex: si,
          seriesName: this.series[si]?.name ?? `${si + 1}`,
          categoryLabel: cat.label,
          value,
          gradId: `ui-bar-grad-${this.seq}-${ci}-${si}`,
        });
      }
    });
    return rects;
  }

  /**
   * Category ticks centred under each group. For dense data (e.g. 30–90 daily bars) the labels
   * are thinned to ~{@link MAX_TICK_LABELS} evenly-spaced (always incl. first + last) so they
   * never overlap; the bars themselves still render for every category.
   */
  get ticks(): UiChartBarTick[] {
    const cats = this.usable;
    if (cats.length === 0) return [];
    const plotW = VB_W - PAD_LEFT - PAD_RIGHT;
    const groupWidth = plotW / cats.length;
    const stepN = cats.length > MAX_TICK_LABELS ? Math.ceil(cats.length / MAX_TICK_LABELS) : 1;
    const out: UiChartBarTick[] = [];
    cats.forEach((cat, ci) => {
      if (ci % stepN === 0 || ci === cats.length - 1) {
        out.push({ label: cat.label, x: PAD_LEFT + groupWidth * ci + groupWidth / 2 });
      }
    });
    return out;
  }

  /** Per-series vertical gradient defs (gradient mode only): lighter top → full hue bottom. */
  get gradientDefs(): { id: string; from: string; to: string }[] {
    if (!this.gradient) return [];
    // One gradient per rendered bar so per-category hues each get their own light→full ramp.
    return this.bars
      .filter(rect => rect.height > 0)
      .map(rect => ({
        id: rect.gradId,
        from: `color-mix(in srgb, ${rect.color} 58%, #fff)`,
        to: rect.color,
      }));
  }

  /** Fill for a bar — its own gradient (gradient mode) or its flat hue. */
  barFill(rect: UiChartBarRect): string {
    return this.gradient ? `url(#${rect.gradId})` : rect.color;
  }

  /** Positions (centre-x %, top-y %) + formatted value for the opt-in value labels above bars. */
  get valueLabelItems(): { label: string; xPct: number; yPct: number }[] {
    if (!this.valueLabels) return [];
    return this.bars
      .filter(rect => rect.height > 0)
      .map(rect => ({
        label: this.formatVal(rect.value),
        xPct: ((rect.x + rect.width / 2) / VB_W) * 100,
        yPct: (rect.y / VB_H) * 100,
      }));
  }

  get baselineY(): number {
    return PAD_TOP + (VB_H - PAD_TOP - PAD_BOTTOM);
  }

  /** Bar outline with a rounded top and a flat base on the axis (cleaner than a capsule). */
  barPath(rect: UiChartBarRect): string {
    const { width: w, height: h, x, y } = rect;
    if (h <= 0) return '';
    const r = Math.min(w / 2, h);
    const x2 = x + w;
    const yb = y + h;
    const f = (n: number): string => n.toFixed(2);
    return (
      `M${f(x)},${f(yb)}` +
      `L${f(x)},${f(y + r)}` +
      `Q${f(x)},${f(y)} ${f(x + r)},${f(y)}` +
      `L${f(x2 - r)},${f(y)}` +
      `Q${f(x2)},${f(y)} ${f(x2)},${f(y + r)}` +
      `L${f(x2)},${f(yb)}Z`
    );
  }

  trackByBar(_index: number, rect: UiChartBarRect): string {
    return `${rect.categoryLabel}|${rect.seriesName}`;
  }

  trackByTick(_index: number, tick: UiChartBarTick): string {
    return tick.label;
  }

  trackByGrid(_index: number, grid: UiChartBarGrid): number {
    return grid.y;
  }

  trackByLegend(_index: number, item: UiChartBarLegendItem): string {
    return item.name;
  }
}
