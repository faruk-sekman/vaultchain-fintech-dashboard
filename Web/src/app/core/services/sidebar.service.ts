/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, computed, signal } from '@angular/core';

const SIDEBAR_STORAGE_KEY = 'sidebar-collapsed';

/**
 * A1 (bugfix-backlog-2026-07): below this viewport width the OPEN rail (290px) squeezes content
 * tables too hard, so the rail auto-collapses. 1280 aligns with the customer-detail 1320/1024
 * reflow band — the widest threshold at which the main tables keep comfortable columns.
 */
const AUTO_COLLAPSE_BREAKPOINT = 1280;

/**
 * Desktop sidebar collapsed-state store. Mirrors {@link ThemeService}/{@link DensityService}:
 * a readonly signal + setters, persisted to `localStorage['sidebar-collapsed']` so the rail
 * stays as the operator left it across reloads. Storage being unavailable (private mode,
 * blocked, SSR) is non-fatal — the preference simply lives in memory for the session.
 *
 * A1 semantics:
 *  - CLEAN profile (no stored value) starts COLLAPSED — the calm default; opening it once is a
 *    persisted preference.
 *  - AUTO-COLLAPSE is a TEMPORARY viewport clamp (matchMedia < {@link AUTO_COLLAPSE_BREAKPOINT}):
 *    it never overwrites the saved preference, so widening the window restores exactly what the
 *    operator had chosen. Manually EXPANDING while clamped releases the clamp until the viewport
 *    crosses the threshold again (an explicit act wins over the automation).
 *
 * Only the desktop rail (≥1024px) reads this; below that the rail is replaced by the mobile
 * drawer, which is unaffected.
 */
@Injectable({ providedIn: 'root' })
export class SidebarService {
  /** The operator's persisted choice — never touched by the viewport clamp. */
  private readonly userCollapsed = signal<boolean>(this.readInitial());
  /** The temporary viewport clamp (A1 auto-collapse). */
  private readonly autoCollapsed = signal<boolean>(false);

  /** Whether the desktop rail is collapsed to its icon-only width (preference OR viewport clamp). */
  readonly collapsed = computed(() => this.userCollapsed() || this.autoCollapsed());

  constructor() {
    this.watchViewport();
  }

  toggle(): void {
    if (this.collapsed()) {
      // Expanding is an explicit operator act: persist the preference AND release the clamp so
      // the rail actually opens even below the breakpoint.
      this.autoCollapsed.set(false);
      this.setCollapsed(false);
      return;
    }
    this.setCollapsed(true);
  }

  setCollapsed(collapsed: boolean): void {
    this.userCollapsed.set(collapsed);
    this.persist(collapsed);
  }

  private watchViewport(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      const query = window.matchMedia(`(max-width: ${AUTO_COLLAPSE_BREAKPOINT - 1}px)`);
      this.autoCollapsed.set(query.matches);
      // Root-scoped service (app lifetime) — the listener needs no teardown.
      query.addEventListener('change', event => this.autoCollapsed.set(event.matches));
    } catch {
      // matchMedia quirks (some test environments) — the clamp simply stays off.
    }
  }

  private readInitial(): boolean {
    const storage = this.getStorage();
    // A1: a CLEAN profile starts collapsed; an explicit stored choice ('0' open / '1' collapsed) wins.
    if (!storage) return true;
    try {
      const stored = storage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === null) return true;
      return stored === '1';
    } catch {
      return true;
    }
  }

  private persist(collapsed: boolean): void {
    const storage = this.getStorage();
    if (!storage) return;
    try {
      storage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
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
