/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  NgZone,
  OnDestroy,
  Output,
  inject,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

/** A single activatable row in the menu. */
export interface UiMenuItem {
  kind?: 'item';
  /** Stable identity emitted on select and used for `track`. */
  id: string;
  /** i18n key for the visible label (rendered through `| translate`). */
  labelKey: string;
  /** Optional remix-icon class for a leading icon, e.g. `ri-edit-line`. */
  icon?: string;
  /** Optional trailing hint (already-resolved text, e.g. a keyboard shortcut). */
  shortcut?: string;
  /** Renders the row in the danger foreground colour (e.g. destructive actions). */
  danger?: boolean;
  /** Non-interactive, skipped by keyboard navigation. */
  disabled?: boolean;
}

/** A non-interactive section heading. */
export interface UiMenuSection {
  kind: 'section';
  id: string;
  labelKey: string;
}

/** A horizontal divider between groups. */
export interface UiMenuDivider {
  kind: 'divider';
  id: string;
}

export type UiMenuEntry = UiMenuItem | UiMenuSection | UiMenuDivider;

let uiMenuSeq = 0;

@Component({
  selector: 'app-ui-menu',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './ui-menu.component.html',
  styleUrl: './ui-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiMenuComponent implements AfterViewInit, OnDestroy {
  /** Menu entries: items, section headings and dividers, in render order. */
  @Input() entries: UiMenuEntry[] = [];
  /** Accessible name for the menu surface (i18n key). */
  @Input() menuLabelKey: string | null = null;
  /** Horizontal alignment of the popover relative to the trigger. */
  @Input() align: 'start' | 'end' = 'start';
  /** Visual density/shape of the popover panel. */
  @Input() panelVariant: 'default' | 'profile' = 'default';
  /** Optional non-interactive summary block rendered above the menu rows. */
  @Input() summaryTitle: string | null = null;
  @Input() summarySubtitle: string | null = null;
  @Input() summaryIcon: string | null = null;

  /** Emits the selected item's `id`. */
  @Output() select = new EventEmitter<string>();
  /** Emits whenever the open state changes (true = opened). */
  @Output() openChange = new EventEmitter<boolean>();

  private readonly seq = uiMenuSeq++;
  readonly menuId = `ui-menu-${this.seq}`;
  readonly triggerId = `ui-menu-trigger-${this.seq}`;

  open = false;
  /** Index into `entries` of the currently highlighted item (-1 = none). */
  activeIndex = -1;
  /** Set when the popover must flip above the trigger (near the bottom edge). */
  flipUp = false;
  /** Set when the popover must flip to align its right edge (near the right edge). */
  flipEnd = false;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Bound once so add/removeEventListener reference the same function. */
  private readonly onDocumentPointer = (event: Event): void => {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.zone.run(() => this.close(false));
    }
  };

  ngAfterViewInit(): void {
    // The menu-button ARIA lives on the projected, focusable trigger button (not the layout span),
    // so screen readers announce "menu button, collapsed/expanded" on the element the user focuses.
    const trigger = this.triggerButton();
    if (trigger) {
      trigger.setAttribute('aria-haspopup', 'menu');
      // Provide the labelledby target id only when the consumer hasn't named the button itself.
      if (!trigger.id) trigger.id = this.triggerId;
    }
    this.syncTriggerAria();
  }

  ngOnDestroy(): void {
    this.detachOutsideListener();
  }

  /** Reflect the open state onto the trigger button so `aria-expanded`/`aria-controls` stay correct. */
  private syncTriggerAria(): void {
    const trigger = this.triggerButton();
    if (!trigger) return;
    trigger.setAttribute('aria-expanded', String(this.open));
    if (this.open) {
      trigger.setAttribute('aria-controls', this.menuId);
    } else {
      trigger.removeAttribute('aria-controls');
    }
  }

  /** True when the entry participates in keyboard navigation and selection. */
  isItem(entry: UiMenuEntry): entry is UiMenuItem {
    return entry.kind === undefined || entry.kind === 'item';
  }

  isSection(entry: UiMenuEntry): entry is UiMenuSection {
    return entry.kind === 'section';
  }

  isDivider(entry: UiMenuEntry): entry is UiMenuDivider {
    return entry.kind === 'divider';
  }

  trackEntry = (_: number, entry: UiMenuEntry): string => entry.id;

  toggle(): void {
    if (this.open) {
      this.close(true);
    } else {
      this.openMenu();
    }
  }

  private openMenu(): void {
    this.open = true;
    this.computePlacement();
    this.activeIndex = this.firstEnabledIndex();
    this.attachOutsideListener();
    this.syncTriggerAria();
    this.openChange.emit(true);
    // Move focus into the menu once it has rendered.
    queueMicrotask(() => this.focusActiveItem());
  }

  /** Close the menu; when `returnFocus`, send focus back to the trigger button. */
  close(returnFocus: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.activeIndex = -1;
    this.detachOutsideListener();
    this.syncTriggerAria();
    this.openChange.emit(false);
    if (returnFocus) {
      this.triggerButton()?.focus();
    }
    this.cdr.markForCheck();
  }

  onItemClick(entry: UiMenuEntry): void {
    if (!this.isItem(entry) || entry.disabled) return;
    this.select.emit(entry.id);
    this.close(true);
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.open) {
      // Open with the keyboard from the trigger (ArrowDown/Up/Enter/Space).
      if (this.isTriggerEvent(event) && this.isOpenKey(event.key)) {
        event.preventDefault();
        this.openMenu();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.activeIndex = this.firstEnabledIndex();
        this.focusActiveItem();
        break;
      case 'End':
        event.preventDefault();
        this.activeIndex = this.lastEnabledIndex();
        this.focusActiveItem();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.activateCurrent();
        break;
      case 'Escape':
        event.preventDefault();
        this.close(true);
        break;
      case 'Tab':
        // Tab leaves the menu entirely; close without stealing focus.
        this.close(false);
        break;
      default:
        break;
    }
  }

  private activateCurrent(): void {
    const entry = this.entries[this.activeIndex];
    if (entry) this.onItemClick(entry);
  }

  private moveActive(direction: 1 | -1): void {
    const count = this.entries.length;
    if (count === 0) return;
    let next = this.activeIndex;
    for (let step = 0; step < count; step++) {
      next = (next + direction + count) % count;
      const entry = this.entries[next];
      if (entry && this.isItem(entry) && !entry.disabled) {
        this.activeIndex = next;
        this.focusActiveItem();
        return;
      }
    }
  }

  private firstEnabledIndex(): number {
    return this.entries.findIndex(e => this.isItem(e) && !e.disabled);
  }

  private lastEnabledIndex(): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && this.isItem(entry) && !entry.disabled) return i;
    }
    return -1;
  }

  private focusActiveItem(): void {
    if (this.activeIndex < 0) return;
    const el = this.host.nativeElement.querySelector<HTMLElement>(
      `#${this.menuId}-item-${this.activeIndex}`,
    );
    el?.focus();
    this.cdr.markForCheck();
  }

  /** Lightweight viewport-edge flip: decide vertical/horizontal flip before paint. */
  private computePlacement(): void {
    this.flipUp = false;
    this.flipEnd = this.align === 'end';
    const trigger = this.triggerButton();
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    // Estimate the popover height (item count * row + padding), capped. Profile rows are 44px (A18).
    const itemCount = this.entries.filter(e => this.isItem(e)).length || 1;
    const rowHeight = this.panelVariant === 'profile' ? 44 : 40;
    const estimated = Math.min(itemCount * rowHeight + (this.hasSummary ? 92 : 12), 360);
    this.flipUp = rect.bottom + estimated > window.innerHeight && rect.top > estimated;
    // Horizontal: if a start-aligned menu would overflow the right edge, align to end.
    const estimatedWidth = this.panelVariant === 'profile' ? 304 : 220;
    if (this.align === 'start' && rect.left + estimatedWidth > window.innerWidth) {
      this.flipEnd = true;
    }
  }

  get hasSummary(): boolean {
    return !!(this.summaryTitle || this.summarySubtitle);
  }

  private attachOutsideListener(): void {
    // Run outside Angular: these fire on every document interaction.
    this.zone.runOutsideAngular(() => {
      // `capture` so we see the click before any inner stopPropagation.
      document.addEventListener('pointerdown', this.onDocumentPointer, true);
    });
  }

  private detachOutsideListener(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointer, true);
  }

  private triggerButton(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('[data-ui-menu-trigger]');
  }

  private isTriggerEvent(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return !!target?.closest('[data-ui-menu-trigger]');
  }

  private isOpenKey(key: string): boolean {
    return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ';
  }
}
