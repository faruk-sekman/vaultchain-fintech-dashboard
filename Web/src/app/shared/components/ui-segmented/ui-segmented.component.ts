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

/** A single segment. Provide `labelKey` (i18n) or `label` (already-translated). */
export interface UiSegmentItem {
  value: string;
  /** ngx-translate key for the segment label. */
  labelKey?: string;
  /** Pre-translated label; used when `labelKey` is absent. */
  label?: string;
  /** Optional RemixIcon class. When the segment has no text the icon needs `ariaLabel`. */
  icon?: string;
  /** Accessible name when the segment is icon-only (no label/labelKey). */
  ariaLabel?: string;
  disabled?: boolean;
}

export type UiSegmentedSize = 'sm' | 'md';
/** Visual emphasis of the active segment. `brand` paints the active chip with the brand gradient. */
export type UiSegmentedVariant = 'default' | 'brand';

let segmentedSeq = 0;

/**
 * Segmented control (§5.18). Pill track `--color-surface-2`; active segment is a raised
 * `--color-surface` chip with `--shadow-xs`. Exposed as `role=radiogroup`; each segment is a
 * `role=radio`. Keyboard: ArrowLeft/Right (+ Up/Down) move and select, Home/End jump,
 * Enter/Space (re)select. Used for chart range and header theme/lang toggles.
 */
@Component({
  selector: 'app-ui-segmented',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './ui-segmented.component.html',
  styleUrl: './ui-segmented.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSegmentedComponent {
  readonly items = input<ReadonlyArray<UiSegmentItem>>([]);
  /** Currently selected segment value. */
  readonly value = input<string | null>(null);
  readonly size = input<UiSegmentedSize>('md');
  /** Active-segment emphasis. Use `brand` to make the current choice stand out (e.g. language). */
  readonly variant = input<UiSegmentedVariant>('default');
  /** Accessible name for the whole group (the radiogroup). */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);

  readonly valueChange = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly seq = segmentedSeq++;

  segmentId(value: string): string {
    return `ui-segment-${this.seq}-${value}`;
  }

  isSelected(item: UiSegmentItem): boolean {
    return item.value === this.value();
  }

  /** Roving tabindex: the selected (or first enabled) segment is the single tab stop. */
  tabIndexFor(item: UiSegmentItem): number {
    if (item.disabled) return -1;
    if (this.value() === null) return item.value === this.firstEnabledValue() ? 0 : -1;
    return this.isSelected(item) ? 0 : -1;
  }

  /** Icon-only segments must carry an explicit accessible name. */
  accessibleName(item: UiSegmentItem): string | null {
    if (item.label || item.labelKey) return null;
    return item.ariaLabel ?? null;
  }

  trackByValue(_index: number, item: UiSegmentItem): string {
    return item.value;
  }

  select(item: UiSegmentItem): void {
    if (item.disabled || item.value === this.value()) return;
    this.valueChange.emit(item.value);
  }

  onKeydown(event: KeyboardEvent, item: UiSegmentItem): void {
    const key = event.key;
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      this.select(item);
      return;
    }

    const enabled = this.enabledItems();
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex(s => s.value === item.value);
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
    this.focusSegment(next.value);
    this.select(next);
  }

  private enabledItems(): UiSegmentItem[] {
    return this.items().filter(s => !s.disabled);
  }

  private firstEnabledValue(): string | null {
    return this.enabledItems()[0]?.value ?? null;
  }

  private focusSegment(value: string): void {
    // Ids are seq-scoped and globally unique; getElementById avoids CSS-selector
    // escaping (CSS.escape isn't available everywhere) and is safe for any value string.
    const doc = this.host.nativeElement.ownerDocument;
    doc?.getElementById(this.segmentId(value))?.focus();
  }
}
