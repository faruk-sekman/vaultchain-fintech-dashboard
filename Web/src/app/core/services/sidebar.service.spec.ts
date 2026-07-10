/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SidebarService } from '@core/services/sidebar.service';

/** Controllable matchMedia double for the A1 auto-collapse clamp. */
function stubViewport(initialNarrow: boolean) {
  let listener: ((event: { matches: boolean }) => void) | undefined;
  const mql = {
    matches: initialNarrow,
    addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
      listener = cb;
    },
  };
  const spy = vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(() => mql as unknown as MediaQueryList);
  return { spy, cross: (narrow: boolean) => listener?.({ matches: narrow }) };
}

describe('SidebarService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A1: a CLEAN profile defaults to COLLAPSED', () => {
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(true);
  });

  it('initializes from a persisted collapsed preference', () => {
    localStorage.setItem('sidebar-collapsed', '1');
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(true);
  });

  it('respects an explicit stored OPEN preference across reloads', () => {
    localStorage.setItem('sidebar-collapsed', '0');
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(false);
  });

  it('toggles and persists the collapsed state', () => {
    localStorage.setItem('sidebar-collapsed', '0');
    const service = TestBed.runInInjectionContext(() => new SidebarService());

    service.toggle();
    expect(service.collapsed()).toBe(true);
    expect(localStorage.getItem('sidebar-collapsed')).toBe('1');

    service.toggle();
    expect(service.collapsed()).toBe(false);
    expect(localStorage.getItem('sidebar-collapsed')).toBe('0');
  });

  it('sets the collapsed state explicitly and persists it', () => {
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    service.setCollapsed(true);
    expect(service.collapsed()).toBe(true);
    expect(localStorage.getItem('sidebar-collapsed')).toBe('1');
  });

  it('A1: auto-collapses below the breakpoint WITHOUT touching the saved preference', () => {
    localStorage.setItem('sidebar-collapsed', '0'); // the operator prefers it OPEN
    const { cross } = stubViewport(false);
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(false);

    cross(true); // viewport narrows past the threshold
    expect(service.collapsed()).toBe(true); // clamped…
    expect(localStorage.getItem('sidebar-collapsed')).toBe('0'); // …but the preference survives

    cross(false); // widen again
    expect(service.collapsed()).toBe(false); // the saved preference is back
  });

  it('A1: starting NARROW clamps immediately (matchMedia initial state)', () => {
    localStorage.setItem('sidebar-collapsed', '0');
    stubViewport(true);
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(true);
  });

  it('A1: manually EXPANDING while clamped releases the clamp until the next crossing', () => {
    localStorage.setItem('sidebar-collapsed', '0');
    const { cross } = stubViewport(true);
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(true); // clamped at start

    service.toggle(); // explicit operator act: open it even though we are narrow
    expect(service.collapsed()).toBe(false);

    cross(true); // the next boundary crossing re-engages the clamp
    expect(service.collapsed()).toBe(true);
  });

  it('handles read errors gracefully (falls back to the collapsed default, no crash)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('nope');
    });
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    expect(service.collapsed()).toBe(true);
    spy.mockRestore();
  });

  it('keeps the selection in memory when persisting fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    service.setCollapsed(true);
    expect(service.collapsed()).toBe(true);
  });

  it('stays usable when window is undefined (storage unavailable → collapsed default)', () => {
    stubViewport(false); // deterministic viewport: this test is about STORAGE, not the clamp
    const service = TestBed.runInInjectionContext(() => new SidebarService());
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = undefined;

    service.setCollapsed(false);
    expect(service.collapsed()).toBe(false);
    expect((service as unknown as { readInitial(): boolean }).readInitial()).toBe(true);

    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('keeps the clamp disabled when matchMedia throws', () => {
    localStorage.setItem('sidebar-collapsed', '0');
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('matchMedia unavailable');
    });

    const service = TestBed.runInInjectionContext(() => new SidebarService());

    expect(service.collapsed()).toBe(false);
  });

  it('falls back when the localStorage accessor itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked accessor');
    });

    const service = TestBed.runInInjectionContext(() => new SidebarService());

    expect(service.collapsed()).toBe(true);
  });

  it('falls back when the localStorage accessor returns null', () => {
    stubViewport(false);
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(null as unknown as Storage);

    const service = TestBed.runInInjectionContext(() => new SidebarService());

    expect(service.collapsed()).toBe(true);
    service.setCollapsed(false);
    expect(service.collapsed()).toBe(false);
  });
});
