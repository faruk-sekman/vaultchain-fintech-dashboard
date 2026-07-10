/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { UiConfirmDialogComponent } from './ui-confirm-dialog.component';

/**
 * These tests exercise the focus-management logic directly (move-in, trap, restore).
 * The component queries `.confirm-card` from its host ElementRef, so we mount a real
 * card DOM under a host element and provide it as the injected ElementRef. This keeps
 * the test deterministic and avoids rendering the translate pipe.
 */
describe('UiConfirmDialogComponent focus management', () => {
  let trigger: HTMLButtonElement;
  let host: HTMLElement;
  let card: HTMLDivElement;
  let cancelBtn: HTMLButtonElement;
  let confirmBtn: HTMLButtonElement;

  function makeComponent(): UiConfirmDialogComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        { provide: ElementRef, useValue: new ElementRef(host) },
      ],
    });
    return TestBed.runInInjectionContext(() => {
      const c = new UiConfirmDialogComponent();
      // Mark the view as ready (normally done by ngAfterViewInit).
      (c as unknown as { viewReady: boolean }).viewReady = true;
      return c;
    });
  }

  beforeEach(() => {
    TestBed.resetTestingModule();

    trigger = document.createElement('button');
    trigger.textContent = 'Open';
    document.body.appendChild(trigger);

    host = document.createElement('app-ui-confirm-dialog');
    card = document.createElement('div');
    card.className = 'confirm-card';
    // Source order matters: Cancel first (safe default), Confirm last.
    cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Delete';
    card.appendChild(cancelBtn);
    card.appendChild(confirmBtn);
    host.appendChild(card);
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.replaceChildren();
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

  it('moves focus to the Cancel button when opened (safe default for a destructive action)', async () => {
    trigger.focus();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    // onOpened defers focus via queueMicrotask.
    await Promise.resolve();
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('restores focus to the trigger when closed', async () => {
    trigger.focus();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    await Promise.resolve();
    expect(document.activeElement).toBe(cancelBtn);

    c.open = false;
    c.ngOnChanges(openChange(false, true));
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab from the last element back to the first', () => {
    const c = makeComponent();
    c.open = true;
    confirmBtn.focus(); // last focusable in the card
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(cancelBtn); // wrapped to first
  });

  it('traps Shift+Tab from the first element to the last', () => {
    const c = makeComponent();
    c.open = true;
    cancelBtn.focus(); // first focusable
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(confirmBtn); // wrapped to last
  });

  it('does nothing on Tab when the dialog is closed', () => {
    const c = makeComponent();
    c.open = false;
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(false);
  });

  // --- audit 9C: portal lifecycle, Escape, remaining focus-trap branches ---

  it('portals the overlay to document.body on view init and returns it on destroy', () => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.appendChild(card); // card lives inside the overlay
    host.appendChild(overlay);

    const c = makeComponent();
    c.ngAfterViewInit();
    expect(overlay.parentNode).toBe(document.body);

    c.ngOnDestroy();
    expect(overlay.parentNode).toBe(host);
  });

  it('emits cancel on Escape only when open and not loading', () => {
    const c = makeComponent();
    const spy = vi.fn();
    c.cancel.subscribe(spy);

    c.open = false;
    c.onEscape();
    expect(spy).not.toHaveBeenCalled();

    c.open = true;
    c.loading = true;
    c.onEscape();
    expect(spy).not.toHaveBeenCalled();

    c.loading = false;
    c.onEscape();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps focus inside an empty card on Tab', () => {
    const c = makeComponent();
    c.open = true;
    card.replaceChildren();
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
  });

  it('pulls focus into the card when Tab fires from outside it', () => {
    const c = makeComponent();
    c.open = true;
    trigger.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(true);
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('ignores ngOnChanges with no open change, a first change, or an unchanged value', () => {
    const c = makeComponent();
    expect(() => c.ngOnChanges({})).not.toThrow();
    expect(() => c.ngOnChanges(openChangeRaw(true, false, true))).not.toThrow();
    expect(() => c.ngOnChanges(openChangeRaw(true, true, false))).not.toThrow();
  });

  // --- remaining branches: portal/open-on-init lifecycle + focus-trap edges ---

  it('ngAfterViewInit is a no-op when the host has no overlay element', () => {
    // The default beforeEach host has a bare `.confirm-card`, no `.confirm-overlay`.
    const c = makeComponent();
    expect(() => c.ngAfterViewInit()).not.toThrow();
  });

  it('focuses the Cancel button when already open on first render (ngAfterViewInit)', async () => {
    trigger.focus();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.appendChild(card);
    host.appendChild(overlay);
    const c = makeComponent();
    c.open = true;
    c.ngAfterViewInit();
    await Promise.resolve();
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('ngOnDestroy leaves a non-portaled overlay untouched', () => {
    // No overlay was portaled to the body, so destroy must not try to re-home it.
    const c = makeComponent();
    expect(() => c.ngOnDestroy()).not.toThrow();
  });

  it('Tab is a no-op while focus already rests on the last in-card element', () => {
    const c = makeComponent();
    c.open = true;
    confirmBtn.focus(); // last; forward Tab from here SHOULD wrap, so use Shift+Tab here for the in-bounds branch
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    // Shift+Tab from the last element is in-bounds (active !== first, inside card) → no wrap.
    expect(prevented()).toBe(false);
    expect(document.activeElement).toBe(confirmBtn);
  });

  it('forward Tab from the first in-card element is in-bounds and does not wrap', () => {
    const c = makeComponent();
    c.open = true;
    cancelBtn.focus(); // first; forward Tab is in-bounds (active !== last, inside card)
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);
    c.onTab(event);
    expect(prevented()).toBe(false);
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('records no previously-focused element when nothing held focus on open', () => {
    // body is the activeElement (not an HTMLElement worth restoring beyond body).
    (document.activeElement as HTMLElement | null)?.blur?.();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));
    // Close immediately; restoreFocus must not throw even with no stored trigger.
    c.open = false;
    expect(() => c.ngOnChanges(openChange(false, true))).not.toThrow();
  });

  it('does not fail when opening with an empty card and no focus target', async () => {
    trigger.focus();
    card.replaceChildren();
    const c = makeComponent();
    c.open = true;
    c.ngOnChanges(openChange(true, false));

    await Promise.resolve();

    expect(document.activeElement).toBe(trigger);
  });

  it('returns no focusables when the dialog card is missing', () => {
    card.remove();
    const c = makeComponent();
    c.open = true;
    const event = new KeyboardEvent('keydown', { key: 'Tab' });
    const prevented = spyPreventDefault(event);

    c.onTab(event);

    expect(prevented()).toBe(true);
  });
});

/** SimpleChanges for `open` with an explicit firstChange flag (covers the early-return guards). */
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
