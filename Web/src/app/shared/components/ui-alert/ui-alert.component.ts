/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type UiAlertType = 'success' | 'warning' | 'danger' | 'info';

/**
 * Inline contextual banner (design-system-ui-kit §5.24).
 *
 * Semantic soft background (`*-bg`), 4px left accent (`*-border`), a leading
 * status icon, title/body (via inputs OR projected `[alert-title]` / default
 * body content), and optional action + dismiss controls.
 *
 * Copy is supplied by the caller (already translated) — the primitive holds no
 * literal strings; provide `ariaLabel`/`dismissLabel` for the icon-only close
 * button so it always carries an accessible name.
 */
@Component({
  selector: 'app-ui-alert',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-alert.component.html',
  styleUrl: './ui-alert.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiAlertComponent {
  /** Severity → semantic family + role + default icon. */
  readonly type = input<UiAlertType>('info');
  /** Optional title; may instead be projected via `[alert-title]`. */
  readonly title = input<string | null>(null);
  /** Optional body line; may instead be projected as default content. */
  readonly message = input<string | null>(null);
  /** Override the leading icon (RemixIcon class). Defaults per severity. */
  readonly icon = input<string | null>(null);
  /** Show a trailing dismiss (×) button that emits `dismissed`. */
  readonly dismissible = input(false);
  /** Accessible name for the dismiss button (required when `dismissible`). */
  readonly dismissLabel = input<string | null>(null);
  /** Optional region label, used as the alert's accessible name. */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);
  readonly class = input<string | null>(null);

  /** Emitted when the user activates the dismiss button. */
  readonly dismissed = output<void>();

  private static readonly DEFAULT_ICONS: Record<UiAlertType, string> = {
    success: 'ri-checkbox-circle-line',
    warning: 'ri-error-warning-line',
    danger: 'ri-close-circle-line',
    info: 'ri-information-line',
  };

  /** Warning/danger interrupt assertively; success/info are polite status. */
  get role(): 'alert' | 'status' {
    const type = this.type();
    return type === 'warning' || type === 'danger' ? 'alert' : 'status';
  }

  get iconClass(): string {
    return this.icon() ?? UiAlertComponent.DEFAULT_ICONS[this.type()];
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
