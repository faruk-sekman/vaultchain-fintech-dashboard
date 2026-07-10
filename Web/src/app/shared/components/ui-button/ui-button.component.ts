/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostBinding, input } from '@angular/core';

@Component({
  selector: 'app-ui-button',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-button.component.html',
  styleUrl: './ui-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiButtonComponent {
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  /** `pill` (v2 §4) = outline row-action: --radius-pill, muted 45% border, --color-link text. */
  readonly variant = input<'primary' | 'ghost' | 'danger' | 'pill'>('primary');
  readonly disabled = input(false);
  /** Project-wide action rhythm: sm/md/lg render at the same 44px height. */
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly id = input<string | null>(null);
  readonly class = input<string | null>(null);
  readonly iconOnly = input(false);
  readonly fullWidth = input(false);
  /**
   * Inline loading (motion-system.md §3): keeps width, dims the label,
   * fades a 16px spinner in at iconStart after a 150ms threshold and
   * disables the button while the async action is pending.
   */
  readonly loading = input(false);
  /** Accessible name for the inner button; required for icon-only buttons that have no visible text. */
  readonly ariaLabel = input<string | null>(null);

  @HostBinding('class.ui-button-host') readonly hostClass = true;

  @HostBinding('class.ui-button-host--full')
  get isFullWidth(): boolean {
    return this.fullWidth();
  }
}
