/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { UiTooltipDirective } from './ui-tooltip.directive';

@Component({
  standalone: true,
  imports: [UiTooltipDirective],
  template: `<button [appUiTooltip]="text" aria-label="Refresh">i</button>`,
})
class HostComponent {
  text = 'Refresh data';
}

describe('UiTooltipDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let button: HTMLButtonElement;

  function directive(): UiTooltipDirective {
    return fixture.debugElement
      .query(By.directive(UiTooltipDirective))
      .injector.get(UiTooltipDirective);
  }

  function bubble(): HTMLElement | null {
    return document.body.querySelector('[role="tooltip"]');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    button = fixture.nativeElement.querySelector('button');
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('does not render a tooltip before the show delay elapses', () => {
    directive().onShow();
    expect(bubble()).toBeNull();
  });

  it('does not schedule a duplicate tooltip while one is already visible', () => {
    const dir = directive();
    dir.onShow();
    vi.advanceTimersByTime(300);
    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(1);

    dir.onShow();
    vi.advanceTimersByTime(300);

    expect(document.body.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  });

  it('shows the tooltip on focus after the 300ms delay', () => {
    directive().onShow();
    vi.advanceTimersByTime(300);
    const el = bubble();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Refresh data');
    expect(el!.getAttribute('role')).toBe('tooltip');
  });

  it('links the host via aria-describedby pointing at the tooltip id', () => {
    directive().onShow();
    vi.advanceTimersByTime(300);
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(bubble()!.getAttribute('id')).toBe(describedBy);
  });

  it('removes the tooltip and the aria-describedby link on blur', () => {
    directive().onShow();
    vi.advanceTimersByTime(300);
    expect(bubble()).not.toBeNull();
    directive().onHide();
    expect(bubble()).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('cancels a pending tooltip if hidden before the delay elapses', () => {
    directive().onShow();
    directive().onHide();
    vi.advanceTimersByTime(300);
    expect(bubble()).toBeNull();
  });

  it('renders nothing when the tooltip text is empty', () => {
    // Fresh fixture whose binding is whitespace from the first render (avoids
    // mutating an already-checked binding).
    const blank = TestBed.createComponent(HostComponent);
    blank.componentInstance.text = '   ';
    blank.detectChanges();
    const dir = blank.debugElement
      .query(By.directive(UiTooltipDirective))
      .injector.get(UiTooltipDirective);
    dir.onShow();
    vi.advanceTimersByTime(300);
    expect(bubble()).toBeNull();
    blank.destroy();
  });

  it('Escape hides a visible tooltip', () => {
    directive().onShow();
    vi.advanceTimersByTime(300);
    expect(bubble()).not.toBeNull();
    directive().onEscape();
    expect(bubble()).toBeNull();
  });

  it('cleans up the tooltip node on destroy', () => {
    directive().onShow();
    vi.advanceTimersByTime(300);
    expect(bubble()).not.toBeNull();
    fixture.destroy();
    expect(bubble()).toBeNull();
  });

  // --- reduced-motion + positioning branches ---

  it('skips the rAF fade and shows instantly when reduced motion is preferred', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      directive().onShow();
      vi.advanceTimersByTime(300);
      const el = bubble();
      expect(el).not.toBeNull();
      // Reduced-motion path sets opacity synchronously (no requestAnimationFrame needed).
      expect(el!.style.opacity).toBe('1');
      expect(el!.style.transform).toBe('translateY(0)');
      // No fade transition is registered when motion is reduced.
      expect(el!.style.transition).toBe('');
    } finally {
      window.matchMedia = original;
    }
  });

  it('flips the bubble below the host when there is no room above', () => {
    // Anchor pinned to the very top so the above-placement underflows the margin.
    button.getBoundingClientRect = () =>
      ({ top: 0, bottom: 24, left: 100, width: 40, height: 24 }) as DOMRect;
    directive().onShow();
    vi.advanceTimersByTime(300);
    const el = bubble()!;
    // Flipped path: top = anchor.bottom + scrollY + GAP (24 + 0 + 8 = 32).
    expect(el.style.top).toBe('32px');
  });

  it('clamps the bubble to the left viewport margin for a host near the left edge', () => {
    button.getBoundingClientRect = () =>
      ({ top: 200, bottom: 224, left: -50, width: 40, height: 24 }) as DOMRect;
    directive().onShow();
    vi.advanceTimersByTime(300);
    const el = bubble()!;
    // Centred left would be negative; it is clamped to the 8px viewport margin.
    expect(el.style.left).toBe('8px');
  });

  it('skips positioning math when window is unavailable', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = undefined;
    try {
      directive().onShow();
      vi.advanceTimersByTime(300);
      const el = bubble();
      expect(el).not.toBeNull();
      expect(el!.style.top).toBe('0px');
      expect(el!.style.left).toBe('0px');
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});
