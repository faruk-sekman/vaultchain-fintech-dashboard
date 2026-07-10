/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElementRef, Renderer2 } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiDrawerComponent } from './ui-drawer.component';

/**
 * These tests exercise the drawer's focus-management, scroll-lock and close logic
 * directly. The component queries `.ui-drawer__panel` from its host ElementRef, so we
 * mount a real panel DOM under a host element and provide it as the injected ElementRef.
 */
describe('UiDrawerComponent', () => {
  let trigger: HTMLButtonElement;
  let host: HTMLElement;
  let panel: HTMLElement;
  let closeBtn: HTMLButtonElement;
  let bodyBtn: HTMLButtonElement;

  /** Minimal Renderer2 stub that proxies to inline body styles. */
  const renderer = {
    setStyle: (el: HTMLElement, name: string, value: string) => {
      el.style.setProperty(name, value);
    },
    removeStyle: (el: HTMLElement, name: string) => {
      el.style.removeProperty(name);
    },
  } as unknown as Renderer2;

  function makeComponent(): UiDrawerComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(host) },
        { provide: Renderer2, useValue: renderer },
      ],
    });
    return TestBed.runInInjectionContext(() => {
      const c = new UiDrawerComponent();
      (c as unknown as { viewReady: boolean }).viewReady = true;
      return c;
    });
  }

  beforeEach(() => {
    TestBed.resetTestingModule();

    trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);

    host = document.createElement('app-ui-drawer');
    panel = document.createElement('aside');
    panel.className = 'ui-drawer__panel';
    panel.tabIndex = -1;
    // Source order matters: the close button is rendered first.
    closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    bodyBtn = document.createElement('button');
    bodyBtn.textContent = 'Action';
    panel.appendChild(closeBtn);
    panel.appendChild(bodyBtn);
    host.appendChild(panel);
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.body.style.removeProperty('overflow');
  });

  function openChange(current: boolean, previous: boolean) {
    return {
      open: {
        currentValue: current,
        previousValue: previous,
        firstChange: false,
        isFirstChange: () => false,
      },
    };
  }

  it('defaults to the end anchor and md size', () => {
    const c = makeComponent();
    expect(c.anchor).toBe('end');
    expect(c.size).toBe('md');
  });

  it('moves focus into the panel (close button first) when opened', async () => {
    trigger.focus();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    await Promise.resolve();
    expect(document.activeElement).toBe(closeBtn);
  });

  it('locks body scroll while open and unlocks on close', () => {
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    expect(document.body.style.overflow).toBe('hidden');

    c.open = false;
    c.ngOnChanges(openChange(false, true));
    expect(document.body.style.overflow).toBe('');
  });

  it('restores focus to the trigger when closed', async () => {
    trigger.focus();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    await Promise.resolve();
    expect(document.activeElement).toBe(closeBtn);

    c.open = false;
    c.ngOnChanges(openChange(false, true));
    expect(document.activeElement).toBe(trigger);
  });

  it('emits closed on Escape', () => {
    const c = makeComponent();
    c.open = true;
    const spy = vi.fn();
    c.closed.subscribe(spy);
    c.onEscape();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on Escape when disableClose is set', () => {
    const c = makeComponent();
    c.open = true;
    c.disableClose = true;
    const spy = vi.fn();
    c.closed.subscribe(spy);
    c.onEscape();
    expect(spy).not.toHaveBeenCalled();
  });

  it('emits closed on scrim click by default', () => {
    const c = makeComponent();
    c.open = true;
    const spy = vi.fn();
    c.closed.subscribe(spy);
    c.onScrimClick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on scrim click when closeOnScrim is false', () => {
    const c = makeComponent();
    c.open = true;
    c.closeOnScrim = false;
    const spy = vi.fn();
    c.closed.subscribe(spy);
    c.onScrimClick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('traps Tab from the last element back to the first', () => {
    const c = makeComponent();
    c.open = true;
    bodyBtn.focus(); // last focusable in the panel
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(closeBtn);
  });

  it('traps Shift+Tab from the first element to the last', () => {
    const c = makeComponent();
    c.open = true;
    closeBtn.focus(); // first focusable
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(bodyBtn);
  });

  it('does nothing on Tab when the drawer is closed', () => {
    const c = makeComponent();
    c.open = false;
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(false);
  });

  // --- audit 9C: lifecycle + remaining focus-trap branches ---

  it('runs onOpened from ngAfterViewInit when already open on first render', async () => {
    trigger.focus();
    const c = makeComponent();
    (c as unknown as { viewReady: boolean }).viewReady = false;
    c.open = true;
    c.ngAfterViewInit();
    await Promise.resolve();
    expect(document.activeElement).toBe(closeBtn);
  });

  it('ignores ngOnChanges with no open change, a first change, or an unchanged value', () => {
    const c = makeComponent();
    expect(() => c.ngOnChanges({})).not.toThrow();
    expect(() => c.ngOnChanges(openChangeRaw(true, false, true))).not.toThrow();
    expect(() => c.ngOnChanges(openChangeRaw(true, true, false))).not.toThrow();
    expect(document.body.style.overflow).toBe(''); // none of these locked scroll
  });

  it('unlocks scroll and restores focus on destroy', () => {
    trigger.focus();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    expect(document.body.style.overflow).toBe('hidden');
    c.ngOnDestroy();
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps focus inside an empty panel on Tab (no focusable children)', () => {
    const c = makeComponent();
    c.open = true;
    panel.replaceChildren();
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
  });

  it('pulls focus back into the panel when Tab fires from outside it', () => {
    const c = makeComponent();
    c.open = true;
    trigger.focus(); // active element is OUTSIDE the panel
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(closeBtn);
  });

  // --- remaining branches: in-bounds Tab, panel fallback, lock idempotency ---

  it('ngAfterViewInit does nothing when the drawer is closed on first render', () => {
    const c = makeComponent();
    (c as unknown as { viewReady: boolean }).viewReady = false;
    c.open = false;
    c.ngAfterViewInit();
    expect(document.body.style.overflow).toBe(''); // no scroll lock applied
  });

  it('forward Tab from the first in-panel element is in-bounds and does not wrap', () => {
    const c = makeComponent();
    c.open = true;
    closeBtn.focus(); // first; forward Tab is in-bounds (active !== last, inside panel)
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(false);
    expect(document.activeElement).toBe(closeBtn);
  });

  it('Shift+Tab from the last in-panel element is in-bounds and does not wrap', () => {
    const c = makeComponent();
    c.open = true;
    bodyBtn.focus(); // last; Shift+Tab is in-bounds (active !== first, inside panel)
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(false);
    expect(document.activeElement).toBe(bodyBtn);
  });

  it('focuses the panel itself when it has no focusable children on open', async () => {
    trigger.focus();
    panel.replaceChildren(); // no focusable descendants → focus falls back to the panel
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    await Promise.resolve();
    expect(document.activeElement).toBe(panel);
  });

  it('does not re-lock or double-unlock body scroll (idempotent lock)', () => {
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    expect(document.body.style.overflow).toBe('hidden');
    // A repeated open change must not re-apply the lock (scrollLocked guard).
    c.ngOnChanges(openChange(true, false));
    expect(document.body.style.overflow).toBe('hidden');
    // Close once, then a redundant unlock must be a no-op (not throw / not error).
    c.open = false;
    c.ngOnChanges(openChange(false, true));
    expect(document.body.style.overflow).toBe('');
    expect(() => c.ngOnDestroy()).not.toThrow();
  });

  it('restoreFocus is a no-op when nothing held focus before open', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    c.open = false;
    expect(() => c.ngOnChanges(openChange(false, true))).not.toThrow();
  });
});

/**
 * Template-level: the close (X) affordance must respect `disableClose`, consistent with
 * Escape and scrim. Regression guard for the MFA backup-step lockout: when
 * `disableClose` is set the X must NOT be rendered, so it cannot bypass the gated dismissal.
 */
describe('UiDrawerComponent (template: close affordance respects disableClose)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.body.style.removeProperty('overflow'));

  function render(open: boolean, disableClose: boolean) {
    TestBed.configureTestingModule({ imports: [UiDrawerComponent] });
    const fixture = TestBed.createComponent(UiDrawerComponent);
    fixture.componentRef.setInput('open', open);
    fixture.componentRef.setInput('disableClose', disableClose);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the close (X) button when disableClose is false', () => {
    const fixture = render(true, false);
    expect(fixture.nativeElement.querySelector('.ui-drawer__close')).not.toBeNull();
  });

  it('HIDES the close (X) button when disableClose is true (no dismiss bypass)', () => {
    const fixture = render(true, true);
    expect(fixture.nativeElement.querySelector('.ui-drawer__close')).toBeNull();
  });
});

/** SimpleChanges for `open` with explicit firstChange (covers the early-return guards). */
function openChangeRaw(current: boolean, previous: boolean, firstChange: boolean) {
  return {
    open: {
      currentValue: current,
      previousValue: previous,
      firstChange,
      isFirstChange: () => firstChange,
    },
  };
}

/** Small helper: track whether preventDefault was called on a native event. */
function spyPreventDefault(event: KeyboardEvent): () => boolean {
  let called = false;
  const original = event.preventDefault.bind(event);
  event.preventDefault = () => {
    called = true;
    original();
  };
  return () => called;
}
