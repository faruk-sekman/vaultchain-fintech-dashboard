/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiProgressColor = 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Linear progress bar (design-system-ui-kit §5.25).
 *
 * Track uses `--color-surface-2`; the fill uses `--color-primary` by default or
 * a semantic family via `color`. Determinate mode (default) clamps `value` to
 * 0–100 and exposes `role="progressbar"` with `aria-valuenow/min/max`;
 * `indeterminate` mode animates a sweep and omits the now/min/max values.
 *
 * Any visible `label` is supplied already-translated by the caller.
 */
@Component({
  selector: 'app-ui-progress',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-progress.component.html',
  styleUrl: './ui-progress.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiProgressComponent {
  /** Completion 0–100; clamped. Ignored when `indeterminate`. */
  readonly value = input(0);
  /** When true, render an indeterminate animated sweep. */
  readonly indeterminate = input(false);
  /** Fill colour family. */
  readonly color = input<UiProgressColor>('primary');
  /** Optional caption shown above the bar; also the accessible name. */
  readonly label = input<string | null>(null);
  /** Show the numeric "NN%" value alongside the label (determinate only). */
  readonly showValue = input(false);
  /** Explicit accessible name when no visible `label` is rendered. */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);
  readonly class = input<string | null>(null);

  /** `value` clamped to the 0–100 range for both fill width and aria. */
  get clampedValue(): number {
    const value = this.value();
    if (Number.isNaN(value)) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round(value)));
  }

  get fillStyle(): Record<string, string> {
    return this.indeterminate() ? {} : { width: `${this.clampedValue}%` };
  }
}
