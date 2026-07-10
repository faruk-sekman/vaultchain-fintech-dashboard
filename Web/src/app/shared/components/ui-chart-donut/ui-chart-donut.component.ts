/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Donut chart (design-system-ui-kit.md §5.27 / §6.6). Pure inline SVG — NO chart
 * library, NO canvas (build contract §6.1). Colours come from `--chart-1..8`; the
 * decorative ring is `aria-hidden` and the data is carried by a visually-hidden
 * table + the legend, so meaning never rides on colour alone (§6.9).
 */
import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import {
  UiChartTipComponent,
  UiChartTipRow,
} from '@shared/components/ui-chart-tip/ui-chart-tip.component';

/** One donut slice. `color` overrides the palette default for this slice. */
export interface UiChartDonutDatum {
  /** Already-translated slice label. */
  label: string;
  value: number;
  /** Optional explicit colour (CSS colour or `var(--chart-n)`); palette is used otherwise. */
  color?: string;
}

/** A slice resolved for rendering (geometry + colour + share). */
export interface UiChartDonutSlice {
  readonly label: string;
  readonly value: number;
  readonly color: string;
  /** Share of the total in [0, 1]. */
  readonly fraction: number;
  /** Percentage 0–100, one decimal. */
  readonly percent: number;
  /** `stroke-dasharray` "<len> <gap>" along the circumference. */
  readonly dashArray: string;
  /** `stroke-dashoffset` positioning this slice after the previous ones. */
  readonly dashOffset: number;
  /** v2 §4 inline label: whole-number "x%" text. */
  readonly percentLabel: string;
  /** Mid-arc label anchor, in (unrotated) viewBox units. */
  readonly labelX: number;
  readonly labelY: number;
  /** Inline labels only render where the slice is wide enough to carry 16px text. */
  readonly showLabel: boolean;
  /** Unique id for this slice's `<linearGradient>` (gradient mode only). */
  readonly gradId: string;
}

/** Geometry of the donut SVG (a 100×100 viewBox keeps the math simple). */
const VIEWBOX = 100;
const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Ring thickness ≈ 22% of the radius (§6.6: 22–28%). */
const STROKE_WIDTH = Math.round(RADIUS * 0.22);
/** Gap between segments, in circumference units. Round caps eat ~strokeWidth, so the
 *  visible gap ≈ GAP − strokeWidth; keep it comfortably above the stroke for clean rounded ends. */
const GAP = 13;
/** v2 §4 default palette order: navy → orange → magenta → blue, then the rest. */
const PALETTE_ORDER = [5, 3, 4, 1, 2, 6, 7, 8] as const;
/** Smallest share that can carry a legible inline 16px "%" label. */
const MIN_LABEL_FRACTION = 0.08;

let donutSeq = 0;

@Component({
  selector: 'app-ui-chart-donut',
  standalone: true,
  imports: [CommonModule, UiChartTipComponent],
  templateUrl: './ui-chart-donut.component.html',
  styleUrl: './ui-chart-donut.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiChartDonutComponent {
  /** Slices to plot. Zero/negative values are ignored. */
  @Input() data: ReadonlyArray<UiChartDonutDatum> = [];
  /** Formats the centre total + legend values (e.g. currency/percent). Defaults to a localized integer. */
  /** B2: default value formatting follows the ACTIVE UI language via the central service. */
  private readonly fmt = inject(LocaleFormatService);
  @Input() formatVal: (value: number) => string = v => this.fmt.number(v);
  /** Already-translated caption under the centre total (e.g. "customers"). */
  @Input() centerCaption: string | null = null;
  /** Already-translated accessible summary of the chart's takeaway (SVG `<title>`). */
  @Input() ariaLabel: string | null = null;
  /** Already-translated header for the visually-hidden data table. */
  @Input() tableCaption: string | null = null;
  /** Already-translated "No data" empty-state label. */
  @Input() noDataLabel = 'No data';
  /** Already-translated table column header for the category. */
  @Input() categoryLabel = 'Category';
  /** Already-translated table column header for the value. */
  @Input() valueLabel = 'Value';
  /** Already-translated table column header for the share/percentage. */
  @Input() shareLabel = 'Share';
  /** SVG square size in px. */
  @Input() height = 200;
  @Input() loading = false;
  /**
   * Inline on-ring "x%" labels. Default `true` (v2 §4). Set `false` when the legend already
   * carries the shares and the ring is small enough that on-arc labels would crowd/clip.
   */
  @Input() sliceLabels = true;
  /**
   * Opt-in: fill each segment with a subtle two-tone gradient of its own hue (lighter → full)
   * for a more dimensional, "designed" ring. Default `false` keeps flat segments (e.g. dashboard).
   */
  @Input() gradient = false;
  @Input() id: string | null = null;

  readonly viewBox = VIEWBOX;
  readonly radius = RADIUS;
  readonly center = VIEWBOX / 2;
  readonly strokeWidth = STROKE_WIDTH;
  private readonly seq = donutSeq++;

  /**
   * Per-instance id for the §7 conic-sweep reveal mask (multiple donuts can share
   * a page). The mask is a single ring that "draws on" clockwise via
   * stroke-dashoffset, unveiling the coloured segments as one sweep.
   */
  readonly maskId = `ui-donut-sweep-${this.seq}`;

  /** Mask ring band a touch wider than the segment stroke so round caps never clip. */
  readonly maskStrokeWidth = STROKE_WIDTH + 4;

  /** Hovered slice label (drives the per-slice darken) + the chic tooltip, set on segment mousemove. */
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

  /** Pointer over a slice → surface its value + share in the tooltip, anchored at the cursor. */
  onSliceMove(event: MouseEvent, slice: UiChartDonutSlice): void {
    this.hoverLabel = slice.label;
    this.tip = {
      visible: true,
      x: event.clientX,
      y: event.clientY,
      color: slice.color,
      title: slice.label,
      rows: [
        { label: this.valueLabel, value: this.formatVal(slice.value) },
        { label: this.shareLabel, value: `${slice.percent}%` },
      ],
    };
  }

  onLeave(): void {
    this.hoverLabel = null;
    this.tip = { ...this.tip, visible: false };
  }

  /** Positive-value data only (a donut can't show non-positive shares). */
  private get usable(): ReadonlyArray<UiChartDonutDatum> {
    return this.data.filter(d => Number.isFinite(d.value) && d.value > 0);
  }

  get total(): number {
    return this.usable.reduce((sum, d) => sum + d.value, 0);
  }

  get isEmpty(): boolean {
    return !this.loading && this.total <= 0;
  }

  /** Resolved slices with cumulative dash geometry. */
  get slices(): UiChartDonutSlice[] {
    const items = this.usable;
    const total = this.total;
    if (total <= 0) return [];

    let cumulative = 0;
    return items.map((d, i) => {
      const fraction = d.value / total;
      const len = fraction * CIRCUMFERENCE;
      // Trim the visible arc by the gap (but never below ~1 unit) so segments separate.
      const visible = Math.max(len - GAP, items.length > 1 ? 0.5 : len);
      // v2 §4 inline % label: anchored at the slice's mid-arc on the ring's centreline.
      // The SVG is CSS-rotated -90°, so these coordinates stay in the unrotated frame
      // and each <text> counter-rotates +90° about its own anchor to read upright.
      const midAngle = (cumulative + fraction / 2) * 2 * Math.PI;
      const slice: UiChartDonutSlice = {
        label: d.label,
        value: d.value,
        color: d.color ?? `var(--chart-${PALETTE_ORDER[i % PALETTE_ORDER.length]})`,
        fraction,
        percent: Math.round(fraction * 1000) / 10,
        dashArray: `${visible.toFixed(2)} ${(CIRCUMFERENCE - visible).toFixed(2)}`,
        // SVG strokes start at 3 o'clock; offset shifts each slice to follow the prior ones.
        dashOffset: -cumulative * CIRCUMFERENCE,
        percentLabel: `${Math.round(fraction * 100)}%`,
        labelX: Math.round((this.center + RADIUS * Math.cos(midAngle)) * 100) / 100,
        labelY: Math.round((this.center + RADIUS * Math.sin(midAngle)) * 100) / 100,
        showLabel: fraction >= MIN_LABEL_FRACTION,
        gradId: `ui-donut-grad-${this.seq}-${i}`,
      };
      cumulative += fraction;
      return slice;
    });
  }

  /**
   * Font size (in viewBox units) that renders the inline % labels at 16px on
   * screen for the current `height` (viewBox 100 scales by height/100).
   */
  get percentFontSize(): number {
    const h = this.height > 0 ? this.height : VIEWBOX;
    return Math.round(((16 * VIEWBOX) / h) * 100) / 100;
  }

  get formattedTotal(): string {
    return this.formatVal(this.total);
  }

  trackByLabel(_index: number, slice: UiChartDonutSlice): string {
    return slice.label;
  }
}
