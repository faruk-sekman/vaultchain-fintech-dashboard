/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThemeService } from '@core/services/theme.service';
import { TestBed } from '@angular/core/testing';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes from localStorage and persists changes', async () => {
    localStorage.setItem('b.theme', 'dark');
    const service = TestBed.runInInjectionContext(() => new ThemeService());

    expect(service.theme()).toBe('dark');
    service.setTheme('light');
    await new Promise(r => setTimeout(r, 0));
    expect(service.theme()).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('uses system preference when storage is empty', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: true }) as any);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.theme()).toBe('dark');
  });

  it('defaults to light when system preference is light', () => {
    vi.spyOn(window.localStorage, 'getItem').mockReturnValue(null);
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.theme()).toBe('light');
  });

  it('initializes from localStorage light', () => {
    localStorage.setItem('theme', 'light');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.theme()).toBe('light');
  });

  it('toggles theme', () => {
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    const initial = service.theme();
    service.toggleTheme();
    expect(service.theme()).not.toBe(initial);
    service.toggleTheme();
    expect(service.theme()).toBe(initial);
  });

  it('updates document attributes when theme changes', async () => {
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    service.setTheme('dark');
    await new Promise(r => setTimeout(r, 0));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('handles storage errors gracefully', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('nope');
    });
    const service = TestBed.runInInjectionContext(() => new ThemeService());

    const result = (service as any).readInitialTheme();
    expect(result).toBe('light');
    spy.mockRestore();
  });

  it('handles matchMedia errors gracefully', () => {
    vi.spyOn(window.localStorage, 'getItem').mockReturnValue(null);
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('no media');
    });

    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.theme()).toBe('light');
  });

  it('returns light when window is undefined', () => {
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    const originalWindow = (globalThis as any).window;
    (globalThis as any).window = undefined;
    const result = (service as any).readInitialTheme();
    (globalThis as any).window = originalWindow;
    expect(result).toBe('light');
  });

  it('skips document updates when document is undefined', () => {
    const originalDocument = (globalThis as any).document;
    (globalThis as any).document = undefined;
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    service.setTheme('dark');
    (globalThis as any).document = originalDocument;
    expect(service.theme()).toBe('dark');
  });

  it('keeps theme in memory when persist fails', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    service.setTheme('dark');
    await new Promise(r => setTimeout(r, 0));
    expect(service.theme()).toBe('dark');
  });

  it('defaults to system mode when storage is empty', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('system');
    expect(service.theme()).toBe('light');
  });

  it('setMode persists the chosen mode and resolves the theme', async () => {
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    service.setMode('dark');
    await new Promise(r => setTimeout(r, 0));
    expect(service.mode()).toBe('dark');
    expect(service.theme()).toBe('dark');
    expect(localStorage.getItem('theme-mode')).toBe('dark');
  });

  it('cycleMode walks system → light → dark → system', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('system');
    service.cycleMode();
    expect(service.mode()).toBe('light');
    service.cycleMode();
    expect(service.mode()).toBe('dark');
    service.cycleMode();
    expect(service.mode()).toBe('system');
  });

  it('follows the OS live while in system mode', () => {
    let handler: ((e: unknown) => void) | null = null;
    const mql = {
      matches: false,
      addEventListener: (_: string, h: (e: unknown) => void) => {
        handler = h;
      },
      removeEventListener: () => {
        handler = null;
      },
    };
    vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.theme()).toBe('light');
    mql.matches = true;
    handler?.({ matches: true });
    expect(service.theme()).toBe('dark');
  });

  it('restores a persisted explicit mode over system', () => {
    localStorage.setItem('theme-mode', 'light');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('light');
    expect(service.theme()).toBe('light');
  });

  it('readInitialMode falls back to the legacy `theme` key when no mode is stored', () => {
    // No `theme-mode`, but a legacy explicit `theme` → mode resolves to that explicit value.
    localStorage.setItem('theme', 'dark');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('dark');
    expect(service.theme()).toBe('dark');
  });

  it('readInitialMode falls back to the OLDER `b.theme` legacy key', () => {
    localStorage.setItem('b.theme', 'light');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('light');
  });

  it('readInitialMode ignores an unrecognised stored value and defaults to system', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    localStorage.setItem('theme-mode', 'bogus');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('system');
  });

  it('readInitialMode swallows a storage read error and defaults to system', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(service.mode()).toBe('system');
  });

  it('detaches the OS listener when leaving system mode (removeEventListener branch)', () => {
    const add = vi.fn();
    const remove = vi.fn();
    const mql = { matches: false, addEventListener: add, removeEventListener: remove };
    vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList);
    // Starts in system mode (attaches the listener), then an explicit mode detaches it.
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect(add).toHaveBeenCalledTimes(1);
    service.setMode('dark');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('attachSystemListener swallows a matchMedia error (static resolve, no live updates)', () => {
    let calls = 0;
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      calls += 1;
      // First call (systemTheme during construct) is wrapped in its own try; the second
      // (attachSystemListener) throws so the catch path is exercised.
      if (calls >= 2) throw new Error('mql boom');
      return { matches: false } as unknown as MediaQueryList;
    });
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    // Construction completes (mode stays system) despite the listener-attach failure.
    expect(service.mode()).toBe('system');
  });

  it('getStorage swallows a localStorage access error and returns null (no persistence)', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage denied');
      },
    });
    try {
      const service = TestBed.runInInjectionContext(() => new ThemeService());
      // With storage unavailable the selection still applies in memory.
      service.setMode('dark');
      expect(service.theme()).toBe('dark');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('readInitialTheme reads the legacy `b.theme` key when `theme` is absent', () => {
    localStorage.setItem('b.theme', 'dark');
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    expect((service as any).readInitialTheme()).toBe('dark');
  });

  it('readInitialTheme falls back to the OS preference when no legacy keys are stored', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: true }) as any);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    // No `theme` / `b.theme` keys → resolves via systemTheme() (dark here).
    expect((service as any).readInitialTheme()).toBe('dark');
  });

  it('the live OS handler is a NO-OP once the mode is no longer system', () => {
    let handler: ((e: unknown) => void) | null = null;
    const mql = {
      matches: false,
      addEventListener: (_: string, h: (e: unknown) => void) => (handler = h),
      removeEventListener: () => undefined,
    };
    vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList);
    const service = TestBed.runInInjectionContext(() => new ThemeService());
    // Leave system mode, then fire a stale OS-change event: the resolved theme must NOT flip.
    service.setMode('light');
    mql.matches = true;
    handler?.({ matches: true });
    expect(service.theme()).toBe('light');
  });

  it('getStorage returns null when window.localStorage is absent (?? null branch)', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false }) as any);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => null as unknown as Storage,
    });
    try {
      const service = TestBed.runInInjectionContext(() => new ThemeService());
      service.setMode('dark');
      expect(service.theme()).toBe('dark'); // applies in memory; nothing persisted
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
