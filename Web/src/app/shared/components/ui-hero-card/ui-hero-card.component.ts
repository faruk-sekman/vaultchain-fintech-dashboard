/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** v2.1 §4: `gradient` = --gradient-brand + on-brand text; `outline` = surface + 1px border. */
export type UiHeroCardVariant = 'gradient' | 'outline';

/** One small label/value meta pair — both already translated/formatted by the consumer. */
export interface UiHeroCardMeta {
  label: string;
  value: string;
}

/** One segment of the split bar (e.g. active vs inactive) — a labelled share of a whole. */
export interface UiHeroCardSegment {
  /** Already-translated label. */
  label: string;
  /** Pre-formatted value (count). */
  value: string;
  /** Width share 0–100. */
  pct: number;
}

/** §4 ui-hero-card renders at most two meta pairs in a row. */
const MAX_META = 2;

/**
 * Hero / wallet card — the signature v2.1 gradient widget
 * (visual-design-language-v2.md §4 "ui-hero-card" / §3.3 G6).
 *
 * Anatomy: small label over the big value (25–28/600) top-left · up to TWO
 * small label/value meta pairs in a row · optional bottom footnote line with
 * slightly larger tracking (e.g. a masked wallet/ratio number). Radius
 * `--radius-card`, min-height 200px (contract geometry), padding 24–28.
 *
 * Contract notes: used ONLY with real data (dashboard aggregates, customer
 * wallet); every visible string arrives pre-translated/pre-masked from the
 * consumer — no i18n keys and no masking logic live inside this primitive.
 */
@Component({
  selector: 'app-ui-hero-card',
  standalone: true,
  imports: [],
  templateUrl: './ui-hero-card.component.html',
  styleUrl: './ui-hero-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiHeroCardComponent {
  @Input() variant: UiHeroCardVariant = 'gradient';
  /** Already-translated small label above the big value. */
  @Input() valueLabel = '';
  /** Pre-formatted big value (currency / count). */
  @Input() value: string | number | null = null;
  /** Up to two already-translated label/value meta pairs (extra pairs are not rendered). */
  @Input() meta: ReadonlyArray<UiHeroCardMeta> = [];
  /** Optional already-masked/translated bottom line (e.g. "5234 **** **** 1289"). */
  @Input() footnote: string | null = null;
  @Input() id: string | null = null;
  /** Optional RemixIcon class for a medallion in the card's top corner (e.g. "ri-group-line"). */
  @Input() icon: string | null = null;
  /** Optional 0–100 circular progress ring (e.g. a verified share) shown in the card's corner. */
  @Input() ring: number | null = null;
  /** Optional split-bar segments (e.g. active vs inactive) rendered with a labelled legend. */
  @Input() segments: ReadonlyArray<UiHeroCardSegment> = [];
  /** Render a faint concentric-ring motif in the background (signature on gradient cards). */
  @Input() decorated = false;
  /** Optional small icon shown inline before the value label (a category cue). */
  @Input() labelIcon: string | null = null;
  /** Optional caption under the ring (what the % measures, e.g. "Verified share"). */
  @Input() ringCaption: string | null = null;

  /** The (max two) pairs actually rendered — §4: "two small label/value meta pairs". */
  get metaPairs(): ReadonlyArray<UiHeroCardMeta> {
    return this.meta.slice(0, MAX_META);
  }

  /** Empty when no value was provided (renders an em-dash + screen-reader text). */
  get isEmpty(): boolean {
    return this.value === null || this.value === '';
  }

  /** Ring geometry — a 64-unit box; r=26 leaves room for the 7-wide stroke. */
  readonly ringRadius = 26;
  readonly ringCircumference = 2 * Math.PI * 26;

  /** Clamped 0–100 ring value, or null when no ring should render. */
  get ringPct(): number | null {
    if (this.ring === null || !Number.isFinite(this.ring)) return null;
    return Math.max(0, Math.min(100, this.ring));
  }

  /** Dash offset that fills the ring to {@link ringPct}. */
  get ringDashoffset(): number {
    return this.ringCircumference * (1 - (this.ringPct ?? 0) / 100);
  }

  /** Whole-number "x%" for the ring centre. */
  get ringLabel(): string {
    return `${Math.round(this.ringPct ?? 0)}%`;
  }
}
