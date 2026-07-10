/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Line / area chart (design-system-ui-kit.md §5.27 / §6.3). Pure inline SVG — NO
 * chart library, NO canvas (build contract §6.1). Smooth (Catmull-Rom) line, a
 * vertical gradient area fill derived from `--chart-n` (via SVG <linearGradient>
 * stop-opacity — no `color-mix`), quiet horizontal grid, 0-baseline. The SVG is
 * `aria-hidden`; the data is carried by a visually-hidden table (§6.9).
 */
import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import {
  UiChartTipComponent,
  UiChartTipRow,
} from '@shared/components/ui-chart-tip/ui-chart-tip.component';

/** One x-axis point. `values[i]` aligns with `series[i]`. */
export interface UiChartLineDatum {
  /** Already-translated x label (e.g. a month). */
  label: string;
  /** One value per series. */
  values: number[];
}

/** A named series (drives legend + colour + which one is the filled hero). */
export interface UiChartLineSeries {
  /** Already-translated series name. */
  name: string;
  /** Optional explicit colour; palette is used otherwise. */
  color?: string;
  /** When true, render the vertical gradient area fill under this series (§6.3: one emphasized area). */
  area?: boolean;
}

/** A resolved series path ready to render. */
export interface UiChartLinePath {
  readonly name: string;
  readonly color: string;
  /** Hue of the area gradient (v2 §4: the default hero fills with the #2D60FF blue). */
  readonly areaColor: string;
  readonly linePath: string;
  /** Closed area path (line + baseline), or null when this series isn't filled. */
  readonly areaPath: string | null;
  /** Disconnected zero-length subpaths — one per data point — painted as round dots. */
  readonly dotsPath: string;
  /** Unique gradient id for the area fill. */
  readonly gradientId: string;
  readonly index: number;
}

/** A horizontal gridline with its axis value. */
export interface UiChartLineGrid {
  readonly y: number;
  readonly label: string;
}

/** A positioned x tick. */
export interface UiChartLineTick {
  readonly label: string;
  readonly x: number;
}

/** A resolved legend entry. */
export interface UiChartLineLegendItem {
  readonly name: string;
  readonly color: string;
}

const VB_W = 320;
const VB_H = 180;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const PAD_X = 4;
const GRID_LINES = 4;
/** Catmull-Rom tension (0 = straight, 1 = loose). */
const SMOOTHING = 0.2;
/** Beyond this many points the x labels are thinned so they never overlap. */
const MAX_TICK_LABELS = 8;

let lineSeq = 0;

@Component({
  selector: 'app-ui-chart-line',
  standalone: true,
  imports: [CommonModule, UiChartTipComponent],
  templateUrl: './ui-chart-line.component.html',
  styleUrl: './ui-chart-line.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiChartLineComponent {
  /** Points along the x-axis with one value per series. */
  @Input() data: ReadonlyArray<UiChartLineDatum> = [];
  /** Series metadata; when omitted a single filled series is assumed. */
  @Input() series: ReadonlyArray<UiChartLineSeries> = [];
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
  /** Whether to render the legend (only meaningful for named series). */
  @Input() legend = true;
  /** SVG height in px (width is responsive). */
  @Input() height = 220;
  @Input() loading = false;
  @Input() id: string | null = null;

  readonly viewBoxW = VB_W;
  readonly viewBoxH = VB_H;
  private readonly seq = lineSeq++;

  /** Hover tooltip state, driven by mousemove over the plot (nearest x snaps to a point). */
  hoverIndex: number | null = null;
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

  private get usable(): ReadonlyArray<UiChartLineDatum> {
    return this.data.filter(d => Array.isArray(d.values) && d.values.length > 0);
  }

  private get seriesCount(): number {
    const fromData = this.usable.reduce((max, d) => Math.max(max, d.values.length), 0);
    return Math.max(fromData, this.series.length, 1);
  }

  private seriesColor(index: number): string {
    return this.series[index]?.color ?? `var(--chart-${(index % 8) + 1})`;
  }

  /**
   * v2 §4: the default hero series (stroke --chart-1) fills with the
   * rgb(45 96 255) blue = `--chart-6`; explicitly-coloured series self-derive.
   */
  private seriesAreaColor(index: number): string {
    const explicit = this.series[index]?.color;
    if (explicit) return explicit;
    return index === 0 ? 'var(--chart-6)' : this.seriesColor(index);
  }

  /** Whether a series should be area-filled; defaults to filling a lone series. */
  private seriesIsArea(index: number): boolean {
    if (this.series.length === 0) return index === 0;
    return !!this.series[index]?.area;
  }

  get maxValue(): number {
    let max = 0;
    for (const d of this.usable) {
      for (const v of d.values) {
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    return max;
  }

  /** Need ≥2 points to draw a line. */
  get isEmpty(): boolean {
    return !this.loading && (this.usable.length < 2 || this.maxValue <= 0);
  }

  get hasLegend(): boolean {
    return this.legend && this.series.some(s => !!s.name);
  }

  get legendItems(): UiChartLineLegendItem[] {
    return this.series.map((s, i) => ({ name: s.name, color: s.color ?? this.seriesColor(i) }));
  }

  get gridLines(): UiChartLineGrid[] {
    const max = this.maxValue;
    if (max <= 0) return [];
    const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
    const lines: UiChartLineGrid[] = [];
    for (let i = 0; i <= GRID_LINES; i++) {
      const ratio = i / GRID_LINES;
      lines.push({
        y: PAD_TOP + plotH * ratio,
        label: this.formatVal(Math.round(max * (1 - ratio))),
      });
    }
    return lines;
  }

  /**
   * x-axis ticks. For dense series (e.g. 30–90 daily points) the labels are thinned to
   * ~{@link MAX_TICK_LABELS} evenly-spaced (always incl. first + last) so they stay readable and
   * never overlap; the line/area still uses every point.
   */
  get ticks(): UiChartLineTick[] {
    const pts = this.usable;
    if (pts.length === 0) return [];
    const plotW = VB_W - PAD_X * 2;
    const step = pts.length > 1 ? plotW / (pts.length - 1) : 0;
    const stepN = pts.length > MAX_TICK_LABELS ? Math.ceil(pts.length / MAX_TICK_LABELS) : 1;
    const out: UiChartLineTick[] = [];
    pts.forEach((p, i) => {
      if (i % stepN === 0 || i === pts.length - 1) {
        out.push({ label: p.label, x: PAD_X + step * i });
      }
    });
    return out;
  }

  /** One resolved path per series (line + optional area). */
  get paths(): UiChartLinePath[] {
    const pts = this.usable;
    const max = this.maxValue;
    if (pts.length < 2 || max <= 0) return [];

    const plotW = VB_W - PAD_X * 2;
    const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
    const baseline = PAD_TOP + plotH;
    const step = plotW / (pts.length - 1);
    const n = this.seriesCount;

    const out: UiChartLinePath[] = [];
    for (let si = 0; si < n; si++) {
      const coords = pts.map((p, i) => {
        const value = p.values[si] ?? 0;
        const x = PAD_X + step * i;
        const y = baseline - (value > 0 ? (value / max) * plotH : 0);
        return { x, y };
      });
      const linePath = this.smoothPath(coords);
      const isArea = this.seriesIsArea(si);
      const areaPath = isArea
        ? `${linePath} L ${coords[coords.length - 1].x.toFixed(2)},${baseline.toFixed(2)} ` +
          `L ${coords[0].x.toFixed(2)},${baseline.toFixed(2)} Z`
        : null;
      // v2 §4 point dots: zero-length round-cap subpaths stay circular on screen
      // (vector-effect: non-scaling-stroke) despite the stretched viewBox.
      const dotsPath = coords.map(c => `M ${c.x.toFixed(2)},${c.y.toFixed(2)} h 0.01`).join(' ');
      out.push({
        name: this.series[si]?.name ?? `${si + 1}`,
        color: this.seriesColor(si),
        areaColor: this.seriesAreaColor(si),
        linePath,
        areaPath,
        dotsPath,
        gradientId: `ui-line-grad-${this.seq}-${si}`,
        index: si,
      });
    }
    return out;
  }

  /** Catmull-Rom → cubic-Bézier smoothing for a calm monotone-ish curve (§6.3). */
  private smoothPath(points: ReadonlyArray<{ x: number; y: number }>): string {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x},${points[0].y}`;

    let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i++) {
      // Catmull-Rom control points (scaled by SMOOTHING) converted to a cubic Bézier.
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;
      const cp1x = p1.x + (p2.x - p0.x) * SMOOTHING;
      const cp1y = p1.y + (p2.y - p0.y) * SMOOTHING;
      const cp2x = p2.x - (p3.x - p1.x) * SMOOTHING;
      const cp2y = p2.y - (p3.y - p1.y) * SMOOTHING;
      d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }
    return d;
  }

  /** Pointer moved over the plot → snap to the nearest x and surface its tooltip. */
  onMove(event: MouseEvent): void {
    const rect = (event.currentTarget as SVGGraphicsElement).getBoundingClientRect();
    const pts = this.usable;
    if (pts.length === 0 || rect.width === 0) return;
    const relX = (event.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(relX * (pts.length - 1))));
    this.hoverIndex = i;
    const cols = this.series.length ? this.series : [{ name: '' }];
    const rows: UiChartTipRow[] = cols.map((s, si) => ({
      label: s.name || this.valueLabel,
      value: this.formatVal(pts[i].values[si] ?? 0),
    }));
    this.tip = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      color: this.seriesColor(0),
      title: pts[i].label,
      rows,
    };
  }

  onLeave(): void {
    this.hoverIndex = null;
    this.tip = { ...this.tip, visible: false };
  }

  /** Hovered hero-point coords (viewBox units) for the highlight dot. */
  get hoverPoint(): { x: number; y: number } | null {
    return this.hoverIndex === null ? null : this.pointAt(this.hoverIndex);
  }

  private pointAt(i: number): { x: number; y: number } {
    const pts = this.usable;
    const max = this.maxValue;
    const plotW = VB_W - PAD_X * 2;
    const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
    const baseline = PAD_TOP + plotH;
    const val = pts[i]?.values[0] ?? 0;
    return {
      x: PAD_X + (pts.length > 1 ? (plotW / (pts.length - 1)) * i : 0),
      y: baseline - (val > 0 && max > 0 ? (val / max) * plotH : 0),
    };
  }

  trackByPath(_index: number, path: UiChartLinePath): string {
    return path.name;
  }

  trackByGrid(_index: number, grid: UiChartLineGrid): number {
    return grid.y;
  }

  trackByTick(_index: number, tick: UiChartLineTick): string {
    return tick.label;
  }

  trackByLegend(_index: number, item: UiChartLineLegendItem): string {
    return item.name;
  }
}
