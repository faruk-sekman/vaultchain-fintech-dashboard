/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/** A single tab descriptor. Provide `labelKey` (i18n) or `label` (already-translated). */
export interface UiTabItem {
  value: string;
  /** ngx-translate key for the tab label. */
  labelKey?: string;
  /** Pre-translated label; used when `labelKey` is absent. */
  label?: string;
  /** Optional leading RemixIcon class (e.g. `ri-line-chart-line`). */
  icon?: string;
  /** When true the tab is present but not selectable. */
  disabled?: boolean;
}

let tabsSeq = 0;

/**
 * Underline tabs (§5.18). Roving-tabindex `role=tablist`; active tab text `--color-text`
 * with a 2px `--color-primary` bottom border, inactive `--color-text-muted`.
 * Keyboard: ArrowLeft/Right move + select, Home/End jump, Enter/Space (re)select.
 */
@Component({
  selector: 'app-ui-tabs',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './ui-tabs.component.html',
  styleUrl: './ui-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiTabsComponent {
  readonly items = input<ReadonlyArray<UiTabItem>>([]);
  /** Currently selected tab value. */
  readonly value = input<string | null>(null);
  /** Accessible name for the tablist (icon-only sets especially). */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');
  readonly variant = input<'underline' | 'pills'>('underline');
  readonly wrap = input(false);

  readonly valueChange = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly seq = tabsSeq++;

  /** Stable id base so `aria-controls`/`aria-labelledby` can pair tab↔panel. */
  tabId(value: string): string {
    return `ui-tab-${this.seq}-${value}`;
  }

  /**
   * Panel id paired 1:1 with `tabId(value)`. The `seq` that namespaces these ids is
   * private, so a consumer rendering its own `role="tabpanel"` regions cannot rebuild the
   * id itself — it reads it back through this method via a template ref (`#tabsRef`):
   *   `[id]="tabsRef.panelId(value)"`              ← matches this tab's `aria-controls`
   *   `[attr.aria-labelledby]="tabsRef.tabId(value)"`
   * The `-panel` suffix lives here (and is reused by the template's `aria-controls`) so the
   * tab's `aria-controls` and the panel's `id` can never drift.
   */
  panelId(value: string): string {
    return `${this.tabId(value)}-panel`;
  }

  isSelected(item: UiTabItem): boolean {
    return item.value === this.value();
  }

  /** Roving tabindex: only the selected (or first enabled) tab is tabbable. */
  tabIndexFor(item: UiTabItem): number {
    if (item.disabled) return -1;
    if (this.value() === null) return item.value === this.firstEnabledValue() ? 0 : -1;
    return this.isSelected(item) ? 0 : -1;
  }

  trackByValue(_index: number, item: UiTabItem): string {
    return item.value;
  }

  select(item: UiTabItem): void {
    if (item.disabled || item.value === this.value()) return;
    this.valueChange.emit(item.value);
  }

  /** Arrow/Home/End navigation across enabled tabs; moves focus AND selection. */
  onKeydown(event: KeyboardEvent, item: UiTabItem): void {
    const key = event.key;
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      this.select(item);
      return;
    }

    const enabled = this.enabledItems();
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex(t => t.value === item.value);
    let nextIndex: number | null = null;

    switch (key) {
      case 'ArrowRight':
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % enabled.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = enabled.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = enabled[nextIndex];
    this.focusTab(next.value);
    this.select(next);
  }

  private enabledItems(): UiTabItem[] {
    return this.items().filter(t => !t.disabled);
  }

  private firstEnabledValue(): string | null {
    return this.enabledItems()[0]?.value ?? null;
  }

  private focusTab(value: string): void {
    // Ids are seq-scoped and globally unique; getElementById avoids CSS-selector
    // escaping (CSS.escape isn't available everywhere) and is safe for any value string.
    const doc = this.host.nativeElement.ownerDocument;
    doc?.getElementById(this.tabId(value))?.focus();
  }
}
