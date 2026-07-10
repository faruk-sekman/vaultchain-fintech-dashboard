/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  Renderer2,
  SimpleChanges,
  inject,
} from '@angular/core';

/** End/start-anchored side panel (sheet) — design-system-ui-kit §5.23. */

let uiDrawerSeq = 0;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type UiDrawerSize = 'sm' | 'md' | 'lg';
export type UiDrawerAnchor = 'end' | 'start';

@Component({
  selector: 'app-ui-drawer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-drawer.component.html',
  styleUrl: './ui-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiDrawerComponent implements OnChanges, AfterViewInit, OnDestroy {
  /** Controls visibility; the panel is only in the DOM while `true`. */
  @Input() open = false;
  /** Already-translated drawer title; rendered as the H3 header + accessible name. */
  @Input() title: string | null = null;
  /** Panel width: `sm` 380 · `md` 480 · `lg` 640. */
  @Input() size: UiDrawerSize = 'md';
  /** Which inline edge the panel slides in from. `end` (default) or `start`. */
  @Input() anchor: UiDrawerAnchor = 'end';
  /** When true, Esc and scrim-click do NOT close the drawer. */
  @Input() disableClose = false;
  /** When true (default), clicking the scrim requests close (ignored if `disableClose`). */
  @Input() closeOnScrim = true;
  /** Accessible name for the close icon-button. */
  @Input() closeAriaLabel = 'Close';

  /** Emitted whenever the user requests close (Esc, scrim, or the close button). */
  @Output() closed = new EventEmitter<void>();

  // Unique ids so aria-labelledby resolves even with multiple drawers mounted.
  private readonly seq = uiDrawerSeq++;
  readonly titleId = `ui-drawer-title-${this.seq}`;

  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);

  /** The element focused before the drawer opened, restored on close. */
  private previouslyFocused: HTMLElement | null = null;
  private viewReady = false;
  /** True while we have applied the body scroll lock, so we only undo it once. */
  private scrollLocked = false;

  ngOnChanges(changes: SimpleChanges): void {
    const openChange = changes['open'];
    if (!openChange || openChange.firstChange) return;
    if (openChange.currentValue === openChange.previousValue) return;
    if (openChange.currentValue) {
      this.onOpened();
    } else {
      this.onClosed();
    }
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    // Handle the case where the drawer is open on first render.
    if (this.open) this.onOpened();
  }

  ngOnDestroy(): void {
    this.unlockScroll();
    this.restoreFocus();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open && !this.disableClose) this.closed.emit();
  }

  @HostListener('document:keydown.tab', ['$event'])
  @HostListener('document:keydown.shift.tab', ['$event'])
  onTab(event: Event): void {
    if (!this.open) return;
    const focusables = this.focusableElements();
    if (focusables.length === 0) {
      // Keep focus inside the panel even when it has no focusable children.
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.doc.activeElement as HTMLElement | null;

    if ((event as KeyboardEvent).shiftKey) {
      if (active === first || !this.panelContains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !this.panelContains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /** Scrim click: request close unless disabled or scrim-close is off. */
  onScrimClick(): void {
    if (this.disableClose || !this.closeOnScrim) return;
    this.closed.emit();
  }

  private onOpened(): void {
    // Remember the trigger so focus returns to it on close.
    const active = this.doc.activeElement;
    this.previouslyFocused = active instanceof HTMLElement ? active : null;
    this.lockScroll();
    // Defer until the panel DOM exists, then move focus inside it.
    queueMicrotask(() => {
      if (!this.open || !this.viewReady) return;
      const focusables = this.focusableElements();
      // First focusable in source order is the close button (rendered first).
      const target = focusables[0] ?? this.panel();
      target?.focus();
    });
  }

  private onClosed(): void {
    this.unlockScroll();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const target = this.previouslyFocused;
    this.previouslyFocused = null;
    if (target && typeof target.focus === 'function' && this.doc.contains(target)) {
      target.focus();
    }
  }

  private lockScroll(): void {
    if (this.scrollLocked) return;
    this.renderer.setStyle(this.doc.body, 'overflow', 'hidden');
    this.scrollLocked = true;
  }

  private unlockScroll(): void {
    if (!this.scrollLocked) return;
    this.renderer.removeStyle(this.doc.body, 'overflow');
    this.scrollLocked = false;
  }

  /** The panel, looked up live from the host so timing inside the `@if` never matters. */
  private panel(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('.ui-drawer__panel');
  }

  private focusableElements(): HTMLElement[] {
    const panel = this.panel();
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  private panelContains(node: Node | null): boolean {
    const panel = this.panel();
    return !!panel && !!node && panel.contains(node);
  }
}
