/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Directive, ElementRef, HostListener, inject } from '@angular/core';

/**
 * Plays a one-shot "pop + redraw" micro-interaction on click (CSS-driven; see the
 * `.is-popping` rules + `ui-icon-pop`/`ui-icon-redraw` keyframes in styles/_animations.scss,
 * which also disable it under prefers-reduced-motion). The class is removed on the host's own
 * animationend and re-armed with a reflow so rapid repeat clicks always replay.
 *
 * Usage: `<button appIconPop>…</button>` on icon-bearing controls (e.g. the header tools).
 */
@Directive({
  selector: '[appIconPop]',
  standalone: true,
})
export class IconPopDirective {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  @HostListener('click')
  onClick(): void {
    const node = this.el.nativeElement;
    node.classList.remove('is-popping');
    // Force reflow so re-adding the class restarts the animation on rapid clicks.
    void node.offsetWidth;
    node.classList.add('is-popping');
  }

  @HostListener('animationend', ['$event'])
  onAnimationEnd(event: AnimationEvent): void {
    // Only clear on the host's own pop animation (ignore the child glyph's redraw bubbling up).
    if (event.target === this.el.nativeElement && event.animationName === 'ui-icon-pop') {
      this.el.nativeElement.classList.remove('is-popping');
    }
  }
}
