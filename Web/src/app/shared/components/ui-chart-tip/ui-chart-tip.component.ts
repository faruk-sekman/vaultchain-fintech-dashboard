/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared chart hover tooltip — a small, chic floating card (accent dot + title + value rows) shown
 * right next to the cursor when the operator hovers a chart point/segment. Pure presentation:
 * consumers drive `visible`/`x`/`y`/`color`/`title`/`rows` from their own hover handlers (x/y are
 * the raw clientX/clientY), so every analytics chart shows the *same* tooltip.
 *
 * Positioning note: the card is `position: fixed`, but an ancestor (the layout `.content` carries a
 * held entrance transform) becomes the containing block for fixed descendants — so we subtract that
 * ancestor's viewport offset and place the card just off the cursor, flipping near the edges. This
 * keeps it glued to the pointer regardless of any transformed ancestor.
 */
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, inject, input } from '@angular/core';

export interface UiChartTipRow {
  readonly label: string;
  readonly value: string;
}

@Component({
  selector: 'app-ui-chart-tip',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-chart-tip.component.html',
  styleUrl: './ui-chart-tip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiChartTipComponent {
  readonly visible = input(false);
  /** Cursor viewport position (clientX/clientY) of the hovered point. */
  readonly x = input(0);
  readonly y = input(0);
  /** Accent colour for the dot (the series/segment hue). */
  readonly color = input('var(--color-primary)');
  /** Already-translated row title (e.g. the category/date). */
  readonly title = input('');
  /** Already-translated label/value rows. */
  readonly rows = input<ReadonlyArray<UiChartTipRow>>([]);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** left/top (offset for any transformed/filtered containing block) + a small cursor offset. */
  get style(): Record<string, string> {
    const cb = this.containingBlock();
    const x = this.x();
    const y = this.y();
    // The `: 1920`/`: 1080` arms are SSR-only fallbacks (window undefined); under jsdom (and any
    // browser) `window` is always defined, so those branches are unreachable in tests. v8-ignored so
    // the per-file branch gate isn't blocked by a dead defensive SSR guard rather than padded around.
    /* v8 ignore next 2 */
    const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const tx = x > w - 260 ? 'calc(-100% - 14px)' : '14px';
    const ty = y > h - 150 ? 'calc(-100% - 14px)' : '18px';
    return {
      left: `${x - cb.left}px`,
      top: `${y - cb.top}px`,
      transform: `translate(${tx}, ${ty})`,
    };
  }

  /** Nearest ancestor that establishes a containing block for `position: fixed` (transform/filter/perspective). */
  private containingBlock(): { left: number; top: number } {
    let node: HTMLElement | null = this.host.nativeElement.parentElement;
    while (node && typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(node);
      if (
        (cs.transform && cs.transform !== 'none') ||
        (cs.filter && cs.filter !== 'none') ||
        (cs.perspective && cs.perspective !== 'none')
      ) {
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top };
      }
      node = node.parentElement;
    }
    return { left: 0, top: 0 };
  }
}
