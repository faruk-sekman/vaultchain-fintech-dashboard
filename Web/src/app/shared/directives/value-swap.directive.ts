/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Directive, ElementRef, Input, OnChanges, SimpleChanges, inject } from '@angular/core';

/**
 * KPI value-update motion (motion-system.md §5) — replaces the count-up.
 *
 * Bind the displayed value: when it changes on an already-rendered element
 * the directive replays the one-shot `value-updating` class, whose CSS
 * animation (`ui-value-swap` in _animations.scss) fades the value out
 * upward (120ms, exit-ease) and back in from below (180ms, enter-ease).
 * Nothing plays on first render — first paint is owned by the skeleton
 * crossfade / page entrance.
 *
 * Usage:
 *   <p class="stat-card__value" [appValueSwap]="value">{{ value }}</p>
 *
 * Presentation only: it toggles a class on the host and never touches the
 * bound data, so it is OnPush-safe and needs no change detection. Reduced
 * motion is honored by the global `prefers-reduced-motion` block (the swap
 * collapses to a direct value change).
 */
@Directive({
  selector: '[appValueSwap]',
  standalone: true,
})
export class ValueSwapDirective implements OnChanges {
  /** The rendered value; any change after first render replays the swap. */
  @Input() appValueSwap: unknown;

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['appValueSwap'];
    if (!change || change.firstChange || change.previousValue === change.currentValue) {
      return;
    }
    this.replay();
  }

  /** Restart the one-shot animation: drop the class, force reflow, re-add. */
  private replay(): void {
    this.host.classList.remove('value-updating');
    // Reading offsetWidth flushes the style change so the animation restarts.
    void this.host.offsetWidth;
    this.host.classList.add('value-updating');
  }
}
