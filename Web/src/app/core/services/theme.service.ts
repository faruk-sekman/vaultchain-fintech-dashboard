/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * App-wide theme service. Supports three modes — `system` (follows the OS `prefers-color-scheme`
 * live), `light`, and `dark` — while exposing the RESOLVED theme (`light`|`dark`) as `theme()` so
 * existing consumers (header toggle, login, etc.) keep working unchanged. The user's chosen mode is
 * persisted under `theme-mode`; the resolved theme is mirrored to the legacy `theme` key for
 * backward compatibility. Selecting `system` attaches a live `matchMedia` listener so the UI follows
 * the OS without a reload.
 */
import { Injectable, signal } from '@angular/core';

/** The user's chosen theme mode. */
export type ThemeMode = 'system' | 'light' | 'dark';
/** The theme actually applied to the document (what UI reacts to). */
export type ResolvedTheme = 'light' | 'dark';

const MODE_STORAGE_KEY = 'theme-mode';
const THEME_STORAGE_KEY = 'theme';
const LEGACY_THEME_STORAGE_KEY = 'b.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  /** Chosen mode (system | light | dark). */
  private readonly modeSignal = signal<ThemeMode>('system');
  /** Resolved theme (light | dark) — the value templates should bind to. */
  private readonly themeSignal = signal<ResolvedTheme>('light');

  readonly mode = this.modeSignal.asReadonly();
  readonly theme = this.themeSignal.asReadonly();

  /** Live OS listener, attached only while mode === 'system'. */
  private mediaQuery: MediaQueryList | null = null;
  private readonly onSystemChange = (): void => {
    if (this.modeSignal() === 'system') this.applyResolved(this.systemTheme());
  };

  constructor() {
    this.setMode(this.readInitialMode(), false);
  }

  /** Back-compat: set an explicit resolved theme (`light` | `dark`). */
  setTheme(theme: ResolvedTheme): void {
    this.setMode(theme);
  }

  /**
   * Set the theme mode. Resolves it (system → OS preference), applies it to the document,
   * (de)attaches the live OS listener, and persists the choice unless `persist` is false.
   */
  setMode(mode: ThemeMode, persist = true): void {
    this.modeSignal.set(mode);
    this.attachSystemListener(mode === 'system');
    const resolved = mode === 'system' ? this.systemTheme() : mode;
    this.applyResolved(resolved);
    if (persist) this.persist(mode, resolved);
  }

  /** Cycle the mode for a 3-state control: system → light → dark → system. */
  cycleMode(): void {
    const current = this.modeSignal();
    const next: ThemeMode =
      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
    this.setMode(next);
  }

  /** Back-compat: flip the RESOLVED theme between light and dark (sets an explicit mode). */
  toggleTheme(): void {
    this.setMode(this.themeSignal() === 'dark' ? 'light' : 'dark');
  }

  /** Resolve and apply a theme to `<html>` (data-theme + color-scheme). */
  private applyResolved(theme: ResolvedTheme): void {
    this.themeSignal.set(theme);
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  }

  /** The OS-preferred theme right now (defensive: defaults to light). */
  private systemTheme(): ResolvedTheme {
    if (typeof window === 'undefined') return 'light';
    try {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  /** Attach/detach the live OS listener (only meaningful in `system` mode). */
  private attachSystemListener(on: boolean): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      if (on && !this.mediaQuery) {
        this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.mediaQuery.addEventListener?.('change', this.onSystemChange);
      } else if (!on && this.mediaQuery) {
        this.mediaQuery.removeEventListener?.('change', this.onSystemChange);
        this.mediaQuery = null;
      }
    } catch {
      // matchMedia unavailable/mocked — fall back to a static resolve; no live updates.
      this.mediaQuery = null;
    }
  }

  /** Read the persisted mode, falling back to a legacy explicit theme, then to `system`. */
  private readInitialMode(): ThemeMode {
    const storage = this.getStorage();
    if (storage) {
      try {
        const stored = storage.getItem(MODE_STORAGE_KEY);
        if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
        const legacy =
          storage.getItem(THEME_STORAGE_KEY) ?? storage.getItem(LEGACY_THEME_STORAGE_KEY);
        if (legacy === 'light' || legacy === 'dark') return legacy;
      } catch {
        return 'system';
      }
    }
    return 'system';
  }

  /**
   * Back-compat helper (still covered by direct unit tests): resolve the initial theme to
   * `light`|`dark` from the legacy storage keys or the OS preference.
   */
  private readInitialTheme(): ResolvedTheme {
    const storage = this.getStorage();
    if (storage) {
      try {
        const stored = storage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
        const legacyStored = storage.getItem(LEGACY_THEME_STORAGE_KEY);
        if (legacyStored === 'light' || legacyStored === 'dark') return legacyStored;
      } catch {
        return 'light';
      }
    }
    if (typeof window === 'undefined') return 'light';
    return this.systemTheme();
  }

  private persist(mode: ThemeMode, resolved: ResolvedTheme): void {
    const storage = this.getStorage();
    if (!storage) return;
    try {
      storage.setItem(MODE_STORAGE_KEY, mode);
      storage.setItem(THEME_STORAGE_KEY, resolved);
    } catch {
      // Preference persistence is non-critical; keep the selection in memory.
    }
  }

  private getStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
      return window.localStorage ?? null;
    } catch {
      return null;
    }
  }
}
