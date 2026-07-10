/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Rendered when the active route declares no `data.titleKey` (e.g. unknown routes). */
export const PAGE_TITLE_FALLBACK_KEY = 'app.title';

/**
 * Single source for the header-owned page title (v2 shell, spec §3.2): the header renders
 * the app's only H1 from here; feature pages stop rendering their own page H1 (P17.4/17.5).
 *
 * - `titleKey` — i18n key resolved from the deepest activated route's `data.titleKey` on
 *   every completed navigation; falls back to `app.title`.
 * - `override` — an already-resolved dynamic title (e.g. the customer's display name on
 *   `/customers/:id`) set by the routed screen via `setOverride()`. It wins over `titleKey`
 *   and is cleared automatically on the next navigation, so a stale name never leaks onto
 *   the following screen.
 */
@Injectable({ providedIn: 'root' })
export class PageTitleService {
  private readonly router = inject(Router);

  private readonly routeTitleKey = signal<string>(PAGE_TITLE_FALLBACK_KEY);
  private readonly overrideValue = signal<string | null>(null);

  /** i18n key for the current route's title (translated by the header template). */
  readonly titleKey = this.routeTitleKey.asReadonly();
  /** Already-resolved dynamic title; when non-null it replaces the translated `titleKey`. */
  readonly override = this.overrideValue.asReadonly();

  constructor() {
    // The service may be created after the first navigation already completed (the header
    // lives inside the lazily-activated main layout), so resolve once from current state.
    this.routeTitleKey.set(this.resolveTitleKey());

    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.overrideValue.set(null);
        this.routeTitleKey.set(this.resolveTitleKey());
      });
  }

  /**
   * Set an already-resolved dynamic title (or `null` to fall back to the route's key).
   * Detail screens call this once their data arrives; navigation clears it.
   */
  setOverride(value: string | null): void {
    this.overrideValue.set(value);
  }

  /** Deepest `data.titleKey` wins, so child routes refine their parents' titles. */
  private resolveTitleKey(): string {
    let snapshot: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    let key = PAGE_TITLE_FALLBACK_KEY;
    while (snapshot) {
      const candidate: unknown = snapshot.data['titleKey'];
      if (typeof candidate === 'string' && candidate.length > 0) {
        key = candidate;
      }
      snapshot = snapshot.firstChild;
    }
    return key;
  }
}
