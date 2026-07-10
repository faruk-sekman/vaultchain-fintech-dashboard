/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeDetectorRef, ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiMenuComponent, UiMenuEntry } from './ui-menu.component';

/**
 * The repo's vitest setup does not resolve `templateUrl`/`styleUrl`, so (like the
 * confirm-dialog spec) we exercise the component logic directly. We mount a real
 * trigger + menu DOM under a host element and provide it as the injected
 * ElementRef, then drive the public API. This keeps the keyboard/open/close/select
 * behaviour under test without rendering the translate pipe.
 */
describe('UiMenuComponent', () => {
  let host: HTMLElement;
  let trigger: HTMLButtonElement;
  let entries: UiMenuEntry[];

  function buildEntries(): UiMenuEntry[] {
    return [
      { kind: 'section', id: 's1', labelKey: 'menu.section' },
      { id: 'edit', labelKey: 'menu.edit', icon: 'ri-edit-line' },
      { id: 'gap', kind: 'divider' },
      { id: 'delete', labelKey: 'menu.delete', danger: true },
    ];
  }

  /**
   * Build the menu instance wired to the host ElementRef. When `withPanel`, also
   * append the item DOM so `focusActiveItem` can resolve `#<menuId>-item-<i>`.
   */
  function makeComponent(): UiMenuComponent {
    TestBed.configureTestingModule({
      providers: [
        { provide: ElementRef, useValue: new ElementRef(host) },
        // ChangeDetectorRef has no root provider; supply a no-op for direct instantiation.
        { provide: ChangeDetectorRef, useValue: { markForCheck: () => {} } },
      ],
    });
    return TestBed.runInInjectionContext(() => {
      const c = new UiMenuComponent();
      c.entries = entries;
      return c;
    });
  }

  /** Render the open menu's item rows so focus lookups resolve. */
  function renderItems(c: UiMenuComponent): void {
    const panel = document.createElement('div');
    panel.className = 'ui-menu__panel';
    entries.forEach((entry, i) => {
      if (entry.kind === 'section' || entry.kind === 'divider') return;
      const btn = document.createElement('button');
      btn.id = `${c.menuId}-item-${i}`;
      btn.className = 'ui-menu__item';
      panel.appendChild(btn);
    });
    host.appendChild(panel);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    entries = buildEntries();

    host = document.createElement('app-ui-menu');
    trigger = document.createElement('button');
    trigger.setAttribute('data-ui-menu-trigger', '');
    trigger.textContent = 'Open';
    host.appendChild(trigger);
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('is closed initially', () => {
    const c = makeComponent();
    expect(c.open).toBe(false);
    expect(c.activeIndex).toBe(-1);
  });

  it('ngAfterViewInit puts menu-button ARIA on the projected trigger button (not a span)', () => {
    const c = makeComponent();
    c.ngAfterViewInit();
    // The focusable button carries the role-bearing ARIA so axe `aria-allowed-attr` is satisfied.
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    // It also gains the labelledby-target id when the consumer left it unnamed.
    expect(trigger.id).toBe(c.triggerId);
  });

  it('keeps a consumer-provided trigger id and still syncs expanded state', () => {
    trigger.id = 'custom-trigger';
    const c = makeComponent();
    c.ngAfterViewInit();
    expect(trigger.id).toBe('custom-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('syncs aria-expanded + aria-controls onto the trigger as the menu opens and closes', () => {
    const c = makeComponent();
    c.ngAfterViewInit();
    c.toggle();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(c.menuId);
    c.close(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('toggle() opens the menu and highlights the first enabled item', () => {
    const c = makeComponent();
    c.toggle();
    expect(c.open).toBe(true);
    expect(c.activeIndex).toBe(1); // index 0 is a section, so the first item is index 1
  });

  it('classifies entries: section / divider / item', () => {
    const c = makeComponent();
    expect(c.isSection(entries[0])).toBe(true);
    expect(c.isDivider(entries[2])).toBe(true);
    expect(c.isItem(entries[1])).toBe(true);
    expect(c.isItem(entries[3])).toBe(true);
  });

  it('emits openChange(true) on open and openChange(false) on close', () => {
    const c = makeComponent();
    const events: boolean[] = [];
    c.openChange.subscribe(v => events.push(v));
    c.toggle();
    c.close(false);
    expect(events).toEqual([true, false]);
  });

  it('ArrowDown skips the divider and lands on the next enabled item', () => {
    const c = makeComponent();
    c.toggle();
    renderItems(c);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(c.activeIndex).toBe(3); // 1 -> 3 (index 2 is a divider)
  });

  it('ArrowUp wraps from the first item to the last item', () => {
    const c = makeComponent();
    c.toggle();
    renderItems(c);
    expect(c.activeIndex).toBe(1);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(c.activeIndex).toBe(3); // wraps to last enabled
  });

  it('Home and End jump to the first and last enabled items', () => {
    const c = makeComponent();
    c.toggle();
    renderItems(c);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'End' }));
    expect(c.activeIndex).toBe(3);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(c.activeIndex).toBe(1);
  });

  it('Enter activates the active item, emits its id, and closes', () => {
    const c = makeComponent();
    let emitted: string | null = null;
    c.select.subscribe(id => (emitted = id));
    c.toggle();
    renderItems(c);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(emitted).toBe('edit');
    expect(c.open).toBe(false);
  });

  it('onItemClick emits the item id and closes; ignores disabled items', () => {
    const c = makeComponent();
    const emitted: string[] = [];
    c.select.subscribe(id => emitted.push(id));
    c.toggle();
    c.onItemClick(entries[3]); // danger "delete"
    expect(emitted).toEqual(['delete']);
    expect(c.open).toBe(false);

    c.toggle();
    c.onItemClick({ id: 'x', labelKey: 'menu.x', disabled: true });
    expect(emitted).toEqual(['delete']); // disabled item does not emit
    expect(c.open).toBe(true); // and does not close
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    const c = makeComponent();
    c.toggle();
    c.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(c.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab closes the menu without stealing focus', () => {
    const c = makeComponent();
    c.toggle();
    c.onKeydown(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(c.open).toBe(false);
  });

  it('an outside pointerdown closes the menu', () => {
    const c = makeComponent();
    c.toggle();
    expect(c.open).toBe(true);
    // A pointerdown on a node outside the host closes it.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(c.open).toBe(false);
  });

  it('a pointerdown inside the host does not close the menu', () => {
    const c = makeComponent();
    c.toggle();
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(c.open).toBe(true);
  });

  it('opens from the trigger via ArrowDown when closed', () => {
    const c = makeComponent();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    Object.defineProperty(event, 'target', { value: trigger });
    c.onKeydown(event);
    expect(c.open).toBe(true);
  });

  it('detaches the outside listener on destroy (no close after teardown)', () => {
    const c = makeComponent();
    c.toggle();
    c.ngOnDestroy();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // Still open because the listener was removed; no late state mutation.
    expect(c.open).toBe(true);
  });

  // --- remaining branches: unhandled keys, all-disabled menus, edge flips ---

  it('ignores an unhandled key while open (no state change)', () => {
    const c = makeComponent();
    c.toggle();
    renderItems(c);
    const before = c.activeIndex;
    c.onKeydown(new KeyboardEvent('keydown', { key: 'x' }));
    expect(c.activeIndex).toBe(before);
    expect(c.open).toBe(true);
  });

  it('a non-open key on the trigger while closed does not open the menu', () => {
    const c = makeComponent();
    const event = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(event, 'target', { value: trigger });
    c.onKeydown(event);
    expect(c.open).toBe(false);
  });

  it('a key while closed from outside the trigger is ignored', () => {
    const c = makeComponent();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    Object.defineProperty(event, 'target', { value: document.body });
    c.onKeydown(event);
    expect(c.open).toBe(false);
  });

  it('navigation is inert when no entry is enabled (all-disabled menu)', () => {
    entries = [
      { id: 'a', labelKey: 'menu.a', disabled: true },
      { kind: 'divider', id: 'd' },
      { id: 'b', labelKey: 'menu.b', disabled: true },
    ];
    const c = makeComponent();
    c.toggle();
    // No enabled item → openMenu leaves activeIndex at -1 (firstEnabledIndex = -1).
    expect(c.activeIndex).toBe(-1);
    // ArrowDown / End cannot land anywhere; activeIndex stays -1.
    c.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(c.activeIndex).toBe(-1);
    c.onKeydown(new KeyboardEvent('keydown', { key: 'End' }));
    expect(c.activeIndex).toBe(-1);
  });

  it('moveActive is a no-op for an empty entry list', () => {
    entries = [];
    const c = makeComponent();
    c.open = true;
    c.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(c.activeIndex).toBe(-1);
  });

  it('flips horizontally to end when a start-aligned menu would overflow the right edge', () => {
    const c = makeComponent();
    // Place the trigger hard against the right viewport edge so a 220px panel overflows.
    trigger.getBoundingClientRect = () =>
      ({ left: window.innerWidth - 4, right: window.innerWidth, top: 100, bottom: 130 }) as DOMRect;
    c.toggle();
    expect(c.flipEnd).toBe(true);
  });

  it('flips up when there is no room below but room above', () => {
    const c = makeComponent();
    trigger.getBoundingClientRect = () =>
      ({
        left: 20,
        right: 60,
        top: window.innerHeight - 10,
        bottom: window.innerHeight,
      }) as DOMRect;
    c.toggle();
    expect(c.flipUp).toBe(true);
  });

  it('toggle() closes an already-open menu', () => {
    const c = makeComponent();
    c.toggle();
    expect(c.open).toBe(true);
    c.toggle();
    expect(c.open).toBe(false);
  });

  it('close() is a no-op when the menu is already closed', () => {
    const c = makeComponent();
    const events: boolean[] = [];
    c.openChange.subscribe(v => events.push(v));
    c.close(true);
    expect(events).toEqual([]); // never emitted because it was already closed
  });

  it('Enter with no active entry does not throw or emit', () => {
    const c = makeComponent();
    const emitted: string[] = [];
    c.select.subscribe(id => emitted.push(id));
    c.toggle();
    c.activeIndex = 99; // out of range → activateCurrent finds no entry
    c.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(emitted).toEqual([]);
    expect(c.open).toBe(true);
  });

  it('a profile-variant menu with a summary still computes placement', () => {
    const c = makeComponent();
    c.panelVariant = 'profile';
    c.summaryTitle = 'Jane Doe';
    expect(c.hasSummary).toBe(true);
    expect(() => c.toggle()).not.toThrow();
    expect(c.open).toBe(true);
  });

  it('ngAfterViewInit and placement tolerate a host with no trigger button', () => {
    // Strip the projected trigger so triggerButton() returns null.
    trigger.remove();
    const c = makeComponent();
    expect(() => c.ngAfterViewInit()).not.toThrow();
    expect(() => c.toggle()).not.toThrow();
    expect(c.open).toBe(true);
  });

  it('placement falls back to one estimated row for an item-less menu', () => {
    entries = [{ kind: 'section', id: 's', labelKey: 'menu.s' }];
    const c = makeComponent();
    // No interactive items → the height estimate uses the `|| 1` fallback; placement still runs.
    expect(() => c.toggle()).not.toThrow();
    expect(c.open).toBe(true);
  });
});
