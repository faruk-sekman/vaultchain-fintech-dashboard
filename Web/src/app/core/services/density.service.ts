/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, signal } from '@angular/core';

/**
 * Operator table-density preference. Mirrors `TableDensity` from the shared
 * `ui-table` (same string union, kept separate so core/ never imports from
 * shared/components — consumers assign the value straight to the table input).
 */
export type DensityMode = 'comfortable' | 'compact';

const DENSITY_STORAGE_KEY = 'density';

/**
 * Density preference store (gap-analysis F4): turns the Settings →
 * Appearance density control from display-only into a working, persisted preference.
 *
 * Mirrors {@link ThemeService}'s contract: a readonly signal + one setter, persisted
 * to `localStorage['density']`. Storage being unavailable (private mode, blocked,
 * SSR) is non-fatal — the preference simply lives in memory for the session.
 */
@Injectable({ providedIn: 'root' })
export class DensityService {
  private readonly densitySignal = signal<DensityMode>(this.readInitialDensity());

  /** Current density preference; tables bind this to their `density` input. */
  readonly density = this.densitySignal.asReadonly();

  setDensity(density: DensityMode): void {
    this.densitySignal.set(density);
    this.persist(density);
  }

  private readInitialDensity(): DensityMode {
    const storage = this.getStorage();
    if (!storage) return 'comfortable';
    try {
      const stored = storage.getItem(DENSITY_STORAGE_KEY);
      if (stored === 'comfortable' || stored === 'compact') return stored;
    } catch {
      // Unreadable storage → default below.
    }
    return 'comfortable';
  }

  private persist(density: DensityMode): void {
    const storage = this.getStorage();
    if (!storage) return;
    try {
      storage.setItem(DENSITY_STORAGE_KEY, density);
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
