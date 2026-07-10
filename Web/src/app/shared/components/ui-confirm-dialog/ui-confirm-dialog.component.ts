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
  SimpleChanges,
  inject,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';

let confirmDialogSeq = 0;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

@Component({
  selector: 'app-ui-confirm-dialog',
  standalone: true,
  imports: [CommonModule, TranslateModule, UiButtonComponent],
  templateUrl: './ui-confirm-dialog.component.html',
  styleUrl: './ui-confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiConfirmDialogComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input() open = false;
  @Input() titleKey = 'common.confirm';
  @Input() messageKey = 'common.confirmMessage';
  @Input() messageParams: Record<string, unknown> | null = null;
  @Input() confirmLabelKey = 'common.delete';
  @Input() cancelLabelKey = 'common.cancel';
  @Input() loadingLabelKey = 'common.deleting';
  @Input() loading = false;
  @Input() icon = 'ri-alert-line';
  @Input() confirmIcon = 'ri-delete-bin-6-line';

  @Output() confirm = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  // Unique ids so aria-labelledby/-describedby resolve even with multiple dialogs.
  private readonly seq = confirmDialogSeq++;
  readonly titleId = `confirm-title-${this.seq}`;
  readonly messageId = `confirm-message-${this.seq}`;

  private readonly doc = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The portaled overlay element (lifted to document.body so no ancestor can ever trap it). */
  private overlayEl: HTMLElement | null = null;
  /** The element focused before the dialog opened, restored on close. */
  private previouslyFocused: HTMLElement | null = null;
  private viewReady = false;

  ngOnChanges(changes: SimpleChanges): void {
    const openChange = changes['open'];
    if (!openChange || openChange.firstChange) return;
    if (openChange.currentValue === openChange.previousValue) return;
    if (openChange.currentValue) {
      this.onOpened();
    } else {
      this.restoreFocus();
    }
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    // Body portal: lift the overlay to document.body so NO transformed/stacking ancestor (header,
    // sidebar, animated page-shell) can trap it — the modal always paints above the whole app.
    this.overlayEl = this.host.nativeElement.querySelector<HTMLElement>('.confirm-overlay');
    if (this.overlayEl) {
      this.doc.body.appendChild(this.overlayEl);
    }
    // Handle the case where the dialog is open on first render.
    if (this.open) this.onOpened();
  }

  ngOnDestroy(): void {
    // Return the portaled overlay under the host so Angular's view teardown removes it cleanly.
    if (this.overlayEl && this.overlayEl.parentNode === this.doc.body) {
      this.host.nativeElement.appendChild(this.overlayEl);
    }
    this.overlayEl = null;
    this.restoreFocus();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open && !this.loading) this.cancel.emit();
  }

  @HostListener('document:keydown.tab', ['$event'])
  @HostListener('document:keydown.shift.tab', ['$event'])
  onTab(event: Event): void {
    if (!this.open) return;
    const focusables = this.focusableElements();
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = this.doc.activeElement as HTMLElement | null;

    if ((event as KeyboardEvent).shiftKey) {
      if (active === first || !this.cardContains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !this.cardContains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  private onOpened(): void {
    // Remember the trigger so focus returns to it on close.
    const active = this.doc.activeElement;
    this.previouslyFocused = active instanceof HTMLElement ? active : null;
    // Defer until the dialog DOM exists, then focus the Cancel button (safe default for a destructive action).
    queueMicrotask(() => {
      if (!this.open || !this.viewReady) return;
      const focusables = this.focusableElements();
      // First focusable in source order is the Cancel button (rendered before Confirm).
      const target = focusables[0] ?? null;
      target?.focus();
    });
  }

  private restoreFocus(): void {
    const target = this.previouslyFocused;
    this.previouslyFocused = null;
    if (target && typeof target.focus === 'function' && this.doc.contains(target)) {
      target.focus();
    }
  }

  /** The dialog card, looked up live from the portaled overlay (falls back to the host pre-portal). */
  private card(): HTMLElement | null {
    const root = this.overlayEl ?? this.host.nativeElement;
    return root.querySelector<HTMLElement>('.confirm-card');
  }

  private focusableElements(): HTMLElement[] {
    const card = this.card();
    if (!card) return [];
    return Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  private cardContains(node: Node | null): boolean {
    const card = this.card();
    return !!card && !!node && card.contains(node);
  }
}
