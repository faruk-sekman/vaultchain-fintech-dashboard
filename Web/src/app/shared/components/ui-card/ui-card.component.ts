/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * `sim` is the ONLY non-default card outline — a dashed `--color-link` border that
 * marks a real-vs-simulated / preview surface (e.g. simulated Web3 risk blocks).
 * It is a compliance-honesty affordance, never decorative.
 */
export type UiCardVariant = 'default' | 'muted' | 'gradient' | 'sim';
export type UiCardPadding = 'sm' | 'md' | 'lg';

/**
 * Card — the fundamental surface primitive (design-system-ui-kit.md §5.11).
 *
 * Anatomy: optional header (title + optional subtitle + [card-actions] slot),
 * body (default content projection), optional [card-footer] slot.
 *
 * The header only renders when a `title`, a `subtitle`, or projected
 * `[card-actions]` content exists. Because content projection cannot be probed
 * cheaply from the class, the actions slot is gated by the `hasActions` input
 * (consumers that project `[card-actions]` set it to `true`). When no header
 * fields are supplied the whole header block is omitted.
 *
 * A11y (§5.11): this component never wraps its content in an interactive
 * element. If the entire card should be clickable, the consumer projects a real
 * `<a>`/`<button>` with an accessible name; do not nest interactive controls
 * inside a clickable card. `interactive` only adds a hover-lift affordance.
 */
@Component({
  selector: 'app-ui-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-card.component.html',
  styleUrl: './ui-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCardComponent {
  /** Card title (already-translated text from the consumer). Renders as the H3 heading. */
  readonly title = input<string | null>(null);
  /** Optional supporting line under the title. */
  readonly subtitle = input<string | null>(null);
  /** Adds the hover-lift affordance (does not make the card focusable). */
  readonly interactive = input(false);
  readonly variant = input<UiCardVariant>('default');
  /** Inner padding: sm (18px) · md (22px) · lg (26px). */
  readonly padding = input<UiCardPadding>('md');
  /** Set true when projecting `[card-actions]` so the header reserves the actions slot. */
  readonly hasActions = input(false);
  /** Set true when projecting `[card-footer]` so the footer region renders. */
  readonly hasFooter = input(false);
  /** Heading level used for the title (semantic flexibility); defaults to 3. */
  readonly headingLevel = input<2 | 3 | 4>(3);
  readonly id = input<string | null>(null);

  /** Header renders when there is a title, a subtitle, or a projected actions slot. */
  get hasHeader(): boolean {
    return this.title() !== null || this.subtitle() !== null || this.hasActions();
  }
}
