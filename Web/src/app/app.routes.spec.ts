/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter, type RedirectFunction } from '@angular/router';
import { routes } from './app.routes';

describe('app routes', () => {
  it('includes dashboard and customers routes', () => {
    const root = routes.find(r => r.path === '');
    expect(root).toBeTruthy();
    const children = (root as any).children as any[];
    const dashboard = children.find(c => c.path === 'dashboard');
    const customers = children.find(c => c.path === 'customers');
    expect(dashboard).toBeTruthy();
    expect(customers).toBeTruthy();
  });

  it('has wildcard redirect', () => {
    const wildcard = routes.find(r => r.path === '**');
    expect(wildcard?.redirectTo).toBe('');
  });

  it('resolves lazy components and children', async () => {
    const root = routes.find(r => r.path === '') as any;
    const main = await root.loadComponent();
    expect(main).toBeDefined();

    const children = root.children as any[];
    const dashboard = children.find(c => c.path === 'dashboard');
    const dashboardComp = await dashboard.loadComponent();
    expect(dashboardComp).toBeDefined();

    const customers = children.find(c => c.path === 'customers');
    const customerRoutes = await customers.loadChildren();
    expect(Array.isArray(customerRoutes)).toBe(true);
  });

  it('resolves the login, analytics and settings lazy components', async () => {
    const login = routes.find(r => r.path === 'login') as any;
    expect(await login.loadComponent()).toBeDefined();

    const root = routes.find(r => r.path === '') as any;
    const children = root.children as any[];
    expect(await children.find(c => c.path === 'analytics').loadComponent()).toBeDefined();
    expect(await children.find(c => c.path === 'settings').loadComponent()).toBeDefined();
  });

  it('resolves the top-level auth lazy routes (mfa/verify + forgot-password closures)', async () => {
    const mfaVerify = routes.find(r => r.path === 'mfa/verify') as any;
    expect(mfaVerify.canActivate).toHaveLength(1); // mfaPendingGuard
    expect(await mfaVerify.loadComponent()).toBeDefined();

    const forgot = routes.find(r => r.path === 'forgot-password') as any;
    expect(await forgot.loadComponent()).toBeDefined();
  });

  it('resolves the settings/mfa lazy component (the remaining child loadComponent closure)', async () => {
    const root = routes.find(r => r.path === '') as any;
    const mfaSetup = (root.children as any[]).find(c => c.path === 'settings/mfa');
    expect(mfaSetup.data?.titleKey).toBe('mfa.setup.pageTitle');
    expect(await mfaSetup.loadComponent()).toBeDefined();
  });

  it('resolves the notifications lazy component (authed, no extra permission gate)', async () => {
    const root = routes.find(r => r.path === '') as any;
    const notifications = (root.children as any[]).find(c => c.path === 'notifications');
    expect(notifications).toBeTruthy();
    // Every operator has their own recipient-scoped feed → no canActivate beyond the shell's authGuard.
    expect(notifications.canActivate).toBeUndefined();
    expect(notifications.data?.titleKey).toBe('notifications.page.title');
    expect(await notifications.loadComponent()).toBeDefined();
  });

  describe('admin-password-reset', () => {
    function adminPwResetRoute(): any {
      const root = routes.find(r => r.path === '') as any;
      return (root.children as any[]).find(c => c.path === 'admin-password-reset');
    }

    it('is a root-level child inside the authGuard shell (a sibling of notifications, not nested under settings)', () => {
      const route = adminPwResetRoute();
      expect(route).toBeTruthy();
      const root = routes.find(r => r.path === '') as any;
      // Sibling of `notifications`, NOT nested under `settings` — keeps the sidebar Settings active-state clean.
      expect((root.children as any[]).some(c => c.path === 'notifications')).toBe(true);
      expect(route.path).toBe('admin-password-reset');
    });

    it('is permission-gated (defense-in-depth) with a single canActivate', () => {
      const route = adminPwResetRoute();
      expect(route.canActivate).toHaveLength(1);
      expect(typeof route.canActivate[0]).toBe('function');
    });

    it('carries the admin password-reset page title key', () => {
      expect(adminPwResetRoute().data?.titleKey).toBe('password.adminReset.pageTitle');
    });

    it('lazy-loads the AdminPasswordResetComponent', async () => {
      expect(await adminPwResetRoute().loadComponent()).toBeDefined();
    });
  });

  describe('admin-reset-requests → admin-password-reset redirects (EK-2)', () => {
    afterEach(() => TestBed.resetTestingModule());

    function requestRoutes(): any[] {
      const root = routes.find(r => r.path === '') as any;
      return (root.children as any[]).filter(c =>
        ['admin-reset-requests', 'admin-reset-requests/:id'].includes(c.path),
      );
    }

    it('keeps BOTH legacy URLs registered — but as pure redirects (no page routes remain)', () => {
      const paths = requestRoutes().map(r => r.path);
      expect(paths).toEqual(['admin-reset-requests', 'admin-reset-requests/:id']);
      for (const route of requestRoutes()) {
        // The review queue is an embedded SECTION of /admin-password-reset now: redirects carry no
        // component, no title and no guard of their own (the TARGET route keeps the permission gate).
        expect(route.loadComponent).toBeUndefined();
        expect(route.canActivate).toBeUndefined();
        expect(route.data).toBeUndefined();
        expect(route.redirectTo).toBeDefined();
      }
    });

    it('redirects the bare list URL to the merged page with a FULL path match (no :id shadowing)', () => {
      const list = requestRoutes().find(r => r.path === 'admin-reset-requests');
      expect(list.redirectTo).toBe('/admin-password-reset');
      // pathMatch full: `admin-reset-requests/req-1` must fall through to the :id redirect below,
      // not prefix-match this one and silently drop the request id.
      expect(list.pathMatch).toBe('full');
    });

    it('carries the old :id deep link over as the ?request= query param (redirect FUNCTION form)', () => {
      const deepLink = requestRoutes().find(r => r.path === 'admin-reset-requests/:id');
      const redirect = deepLink.redirectTo as RedirectFunction;
      expect(typeof redirect).toBe('function');

      // The function runs in an injection context (it builds the UrlTree via the Router).
      TestBed.configureTestingModule({ providers: [provideRouter([])] });
      const router = TestBed.inject(Router);
      const tree = TestBed.runInInjectionContext(() =>
        redirect({ params: { id: 'req-9' } } as never),
      ) as UrlTree;
      expect(router.serializeUrl(tree)).toBe('/admin-password-reset?request=req-9');
    });
  });

  describe('settings/admin-mfa-reset', () => {
    function adminMfaResetRoute(): any {
      const root = routes.find(r => r.path === '') as any;
      return (root.children as any[]).find(c => c.path === 'settings/admin-mfa-reset');
    }

    it('exists inside the authGuard shell with a single canActivate (permission-gated, defense-in-depth)', () => {
      const route = adminMfaResetRoute();
      expect(route).toBeTruthy();
      expect(route.canActivate).toHaveLength(1);
      expect(typeof route.canActivate[0]).toBe('function');
    });

    it('carries the admin-reset page title key', () => {
      expect(adminMfaResetRoute().data?.titleKey).toBe('mfa.adminReset.pageTitle');
    });

    it('lazy-loads the AdminMfaResetComponent', async () => {
      const comp = await adminMfaResetRoute().loadComponent();
      expect(comp).toBeDefined();
    });
  });
});
