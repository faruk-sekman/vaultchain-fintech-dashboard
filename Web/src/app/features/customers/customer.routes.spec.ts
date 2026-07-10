/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { Route } from '@angular/router';
import { customerRoutes } from '@features/customers/customer.routes';

/**
 * O-6: the customer pages are nested under a single pathless wrapper route that registers the
 * feature NgRx slices (`provideCustomersState()`) so they load with this lazy route, not at app
 * bootstrap. The page routes (with their paths/guards/lazy components) are its `children`.
 */
describe('customer routes', () => {
  it('wraps the pages in a single pathless route that provides the feature state', () => {
    expect(customerRoutes).toHaveLength(1);
    const wrapper = customerRoutes[0];
    expect(wrapper.path).toBe('');
    // The wrapper carries route-level providers (the NgRx slice registration) and no component.
    expect(wrapper.providers?.length).toBeGreaterThan(0);
    expect(wrapper.loadComponent).toBeUndefined();
    expect(wrapper.children?.length).toBeGreaterThan(0);
  });

  const pages: Route[] = customerRoutes[0].children ?? [];

  it('defines list, create, detail, edit and web3-risk routes', () => {
    const paths = pages.map(r => r.path);
    expect(paths).toEqual(['', 'new', ':id', ':id/edit', ':id/web3-risk']);
  });

  it('resolves lazy components', async () => {
    for (const route of pages) {
      const comp = await (route as { loadComponent: () => Promise<unknown> }).loadComponent();
      expect(comp).toBeDefined();
    }
  });

  it('guards EVERY page with a canActivate (defense-in-depth)', () => {
    // Read routes (list/detail/web3-risk) carry `customers.read`; write routes (new/edit) carry
    // `customers.manage`. No customer route is reachable by URL without the matching permission.
    for (const route of pages) {
      expect(route.canActivate).toHaveLength(1);
      expect(typeof route.canActivate![0]).toBe('function');
    }
    const open = pages.filter(r => !r.canActivate).map(r => r.path);
    expect(open).toEqual([]);
  });
});
