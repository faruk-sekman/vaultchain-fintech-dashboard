/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { PAGE_TITLE_FALLBACK_KEY, PageTitleService } from './page-title.service';

/** Minimal stand-in for an `ActivatedRouteSnapshot` chain (only what the service reads). */
interface SnapshotNode {
  data: Record<string, unknown>;
  firstChild: SnapshotNode | null;
}

const node = (
  data: Record<string, unknown>,
  firstChild: SnapshotNode | null = null,
): SnapshotNode => ({ data, firstChild });

describe('PageTitleService', () => {
  let events$: Subject<unknown>;
  let routerStub: {
    events: Subject<unknown>;
    routerState: { snapshot: { root: SnapshotNode } };
  };

  const setup = (root: SnapshotNode): PageTitleService => {
    events$ = new Subject<unknown>();
    routerStub = { events: events$, routerState: { snapshot: { root } } };
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: routerStub }],
    });
    return TestBed.inject(PageTitleService);
  };

  it('resolves the deepest route titleKey at construction', () => {
    const service = setup(
      node({}, node({ titleKey: 'customers.title' }, node({ titleKey: 'customerDetail.title' }))),
    );

    expect(service.titleKey()).toBe('customerDetail.title');
    expect(service.override()).toBeNull();
  });

  it('inherits the nearest ancestor titleKey when the leaf has none', () => {
    const service = setup(node({}, node({ titleKey: 'customers.title' }, node({}))));

    expect(service.titleKey()).toBe('customers.title');
  });

  it('falls back to app.title when no route declares a titleKey', () => {
    const service = setup(node({}, node({})));

    expect(service.titleKey()).toBe(PAGE_TITLE_FALLBACK_KEY);
  });

  it('re-resolves on NavigationEnd and ignores other router events', () => {
    const service = setup(node({}, node({ titleKey: 'nav.dashboard' })));
    expect(service.titleKey()).toBe('nav.dashboard');

    routerStub.routerState.snapshot.root = node({}, node({ titleKey: 'analytics.title' }));
    events$.next(new NavigationStart(1, '/analytics'));
    expect(service.titleKey()).toBe('nav.dashboard');

    events$.next(new NavigationEnd(1, '/analytics', '/analytics'));
    expect(service.titleKey()).toBe('analytics.title');
  });

  it('lets setOverride win and clears it on the next navigation', () => {
    const service = setup(node({}, node({ titleKey: 'customerDetail.title' })));

    service.setOverride('Ada Lovelace');
    expect(service.override()).toBe('Ada Lovelace');

    service.setOverride(null);
    expect(service.override()).toBeNull();

    service.setOverride('Ada Lovelace');
    events$.next(new NavigationEnd(2, '/customers', '/customers'));
    expect(service.override()).toBeNull();
    expect(service.titleKey()).toBe('customerDetail.title');
  });
});
