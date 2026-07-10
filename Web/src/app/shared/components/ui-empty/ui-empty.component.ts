/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Centered empty state (design-system-ui-kit §5.26).
 *
 * A muted ~96px illustration glyph (decorative, `aria-hidden`), a title, a
 * supportive line, and an optional primary action. The action is either a
 * built-in real `<button>` (set `actionLabel`, listen to `actionClick`) or a
 * caller-projected control via the `[empty-action]` slot.
 *
 * All copy (`title`, `message`, `actionLabel`) is supplied already-translated.
 */
@Component({
  selector: 'app-ui-empty',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-empty.component.html',
  styleUrl: './ui-empty.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiEmptyComponent {
  /** Decorative illustration glyph (RemixIcon class). */
  readonly icon = input('ri-inbox-line');
  /** Headline (H4). */
  readonly title = input<string | null>(null);
  /** Supportive muted line. */
  readonly message = input<string | null>(null);
  /** Built-in action button label; when set, a real `<button>` is rendered. */
  readonly actionLabel = input<string | null>(null);
  /** Leading icon for the built-in action button (optional). */
  readonly actionIcon = input<string | null>(null);
  readonly id = input<string | null>(null);
  readonly class = input<string | null>(null);

  /** Emitted when the built-in action button is activated. */
  readonly actionClick = output<void>();

  onAction(): void {
    this.actionClick.emit();
  }
}
