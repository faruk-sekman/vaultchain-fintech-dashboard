/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import {
  Directive,
  ElementRef,
  HostListener,
  Input,
  NgZone,
  OnDestroy,
  Renderer2,
  inject,
} from '@angular/core';

let uiTooltipSeq = 0;

const SHOW_DELAY_MS = 300;
const VIEWPORT_MARGIN = 8;
const GAP = 8;

/**
 * Tiny label shown on hover/keyboard-focus for icon-only controls and truncated
 * text (design-system §5.20). The tooltip is supplementary, never the only source
 * of an accessible name — icon-only controls must still carry their own
 * `aria-label`. The directive links the bubble via `aria-describedby`.
 *
 * Usage:
 *   <button aria-label="Refresh" appUiTooltip="Refresh">…</button>
 *   <span class="truncate" [appUiTooltip]="fullName">{{ fullName }}</span>
 *
 * Presentation only: the bubble is created with Renderer2, appended to <body>,
 * styled from design tokens, and removed on hide/destroy. Honors
 * `prefers-reduced-motion` by skipping the fade.
 */
@Directive({
  selector: '[appUiTooltip]',
  standalone: true,
})
export class UiTooltipDirective implements OnDestroy {
  /** The tooltip text. Empty/whitespace disables the tooltip entirely. */
  @Input('appUiTooltip') text = '';

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly renderer = inject(Renderer2);
  private readonly zone = inject(NgZone);

  private readonly tooltipId = `ui-tooltip-${uiTooltipSeq++}`;
  private bubble: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;

  @HostListener('mouseenter')
  @HostListener('focus')
  onShow(): void {
    this.scheduleShow();
  }

  @HostListener('mouseleave')
  @HostListener('blur')
  onHide(): void {
    this.hide();
  }

  @HostListener('keydown.escape')
  onEscape(): void {
    this.hide();
  }

  ngOnDestroy(): void {
    this.hide();
  }

  private scheduleShow(): void {
    const label = this.text.trim();
    if (!label || this.bubble) return;
    this.clearTimer();
    // Timers run outside Angular: this directive does no state change detection.
    this.zone.runOutsideAngular(() => {
      this.showTimer = setTimeout(() => this.show(label), SHOW_DELAY_MS);
    });
  }

  private show(label: string): void {
    if (this.bubble) return;
    const bubble = this.renderer.createElement('div') as HTMLElement;
    this.renderer.setAttribute(bubble, 'role', 'tooltip');
    this.renderer.setAttribute(bubble, 'id', this.tooltipId);
    this.renderer.setProperty(bubble, 'textContent', label);
    this.applyStyles(bubble);
    this.renderer.appendChild(document.body, bubble);
    this.bubble = bubble;

    // Link for screen readers while visible.
    this.renderer.setAttribute(this.host, 'aria-describedby', this.tooltipId);

    this.position(bubble);

    if (!this.prefersReducedMotion()) {
      // Next frame so the §10 fade + 2px rise transitions from the initial state.
      requestAnimationFrame(() => {
        if (this.bubble === bubble) {
          this.renderer.setStyle(bubble, 'opacity', '1');
          this.renderer.setStyle(bubble, 'transform', 'translateY(0)');
        }
      });
    } else {
      this.renderer.setStyle(bubble, 'opacity', '1');
      this.renderer.setStyle(bubble, 'transform', 'translateY(0)');
    }
  }

  private hide(): void {
    this.clearTimer();
    if (this.bubble) {
      this.renderer.removeChild(document.body, this.bubble);
      this.bubble = null;
    }
    this.renderer.removeAttribute(this.host, 'aria-describedby');
  }

  private position(bubble: HTMLElement): void {
    if (typeof window === 'undefined') return;
    const anchor = this.host.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = bubble;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Default above the host, horizontally centered.
    let top = anchor.top + scrollY - h - GAP;
    // Flip below when there is no room above.
    if (anchor.top - h - GAP < VIEWPORT_MARGIN) {
      top = anchor.bottom + scrollY + GAP;
    }

    let left = anchor.left + scrollX + (anchor.width - w) / 2;
    const maxLeft = scrollX + window.innerWidth - w - VIEWPORT_MARGIN;
    const minLeft = scrollX + VIEWPORT_MARGIN;
    left = Math.max(minLeft, Math.min(left, maxLeft));

    this.renderer.setStyle(bubble, 'top', `${Math.round(top)}px`);
    this.renderer.setStyle(bubble, 'left', `${Math.round(left)}px`);
  }

  /** All visual styling comes from design tokens — dark surface, inverse text. */
  private applyStyles(bubble: HTMLElement): void {
    const styles: Record<string, string> = {
      position: 'absolute',
      'z-index': 'var(--z-tooltip)',
      'max-width': '240px',
      padding: 'var(--space-2) var(--space-4)',
      'border-radius': 'var(--radius-xs)',
      background: 'var(--color-text)',
      color: 'var(--color-surface)',
      'font-size': 'var(--font-size-xs)',
      'font-weight': 'var(--font-weight-medium)',
      'line-height': 'var(--line-height-base)',
      'box-shadow': 'var(--shadow-md)',
      'pointer-events': 'none',
      'white-space': 'normal',
      'word-break': 'break-word',
      opacity: '0',
      transform: 'translateY(var(--motion-distance-xs))',
      top: '0',
      left: '0',
    };
    if (!this.prefersReducedMotion()) {
      // §10 menu/tooltip: fade + 2px rise over --motion-fast (120ms).
      styles['transition'] =
        'opacity var(--motion-fast) var(--motion-ease-enter), ' +
        'transform var(--motion-fast) var(--motion-ease-enter)';
    }
    for (const [prop, value] of Object.entries(styles)) {
      this.renderer.setStyle(bubble, prop, value);
    }
  }

  private clearTimer(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }
}
