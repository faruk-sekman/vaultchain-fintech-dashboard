/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MainLayoutComponent (audit 9C Web). Mocks Auth/Router/Sidebar; covers the mobile-nav
 * toggles, the global-search blank guard + navigation, the prepareRoute branches, the ngOnInit
 * principal rehydrate (authenticated-without-principal vs not), and the updateRoute microtask.
 */
import { describe, it, expect, vi } from 'vitest';
import { Router, RouterOutlet } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { SidebarService } from '@core/services/sidebar.service';
import { MainLayoutComponent } from './main-layout.component';

function makeLayout(
  auth: Partial<AuthService> = {},
  router: Partial<Router> = {},
): MainLayoutComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthService,
        useValue: {
          isAuthenticated: () => false,
          principal: () => null,
          loadPrincipal: vi.fn(() => of({})),
          ...auth,
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(), ...router } },
      { provide: SidebarService, useValue: {} },
    ],
  });
  return TestBed.runInInjectionContext(() => new MainLayoutComponent());
}

function outlet(path: string | null, activated = true): RouterOutlet {
  return {
    isActivated: activated,
    activatedRoute: { snapshot: { routeConfig: path === null ? null : { path } } },
  } as unknown as RouterOutlet;
}

describe('MainLayoutComponent', () => {
  it('toggles and closes the mobile nav', () => {
    const c = makeLayout();
    expect(c.mobileNavOpen).toBe(false);
    c.toggleMobileNav();
    expect(c.mobileNavOpen).toBe(true);
    c.closeMobileNav();
    expect(c.mobileNavOpen).toBe(false);
  });

  it('onGlobalSearch ignores a blank query and navigates on a real one', () => {
    const router = { navigate: vi.fn() };
    const c = makeLayout({}, router);
    c.onGlobalSearch('   ');
    expect(router.navigate).not.toHaveBeenCalled();
    c.onGlobalSearch('  ada  ');
    expect(router.navigate).toHaveBeenCalledWith(['/customers'], {
      queryParams: { search: 'ada', page: null },
      queryParamsHandling: 'merge',
    });
  });

  it('prepareRoute returns the active path or the current key', () => {
    const c = makeLayout();
    expect(c.prepareRoute(null as unknown as RouterOutlet)).toBe('home');
    expect(c.prepareRoute(outlet('x', false))).toBe('home');
    expect(c.prepareRoute(outlet('customers'))).toBe('customers');
    expect(c.prepareRoute(outlet(null))).toBe('home'); // routeConfig null -> fallback
  });

  it('ngOnInit rehydrates the principal when authenticated without one', () => {
    const loadPrincipal = vi.fn(() => of({}));
    const c = makeLayout({ isAuthenticated: () => true, principal: () => null, loadPrincipal });
    c.ngOnInit();
    expect(loadPrincipal).toHaveBeenCalled();
  });

  it('ngOnInit does nothing when not authenticated', () => {
    const loadPrincipal = vi.fn(() => of({}));
    const c = makeLayout({ isAuthenticated: () => false, loadPrincipal });
    c.ngOnInit();
    expect(loadPrincipal).not.toHaveBeenCalled();
  });

  it('ngOnInit swallows a principal-rehydrate failure (the catchError → EMPTY arm, no throw)', () => {
    // loadPrincipal rejects (e.g. /auth/me 401 after a stale token) → the catchError swallows it so the
    // shell still renders rather than erroring the whole layout on boot.
    const loadPrincipal = vi.fn(() => throwError(() => ({ status: 401 })));
    const c = makeLayout({ isAuthenticated: () => true, principal: () => null, loadPrincipal });
    expect(() => c.ngOnInit()).not.toThrow();
    expect(loadPrincipal).toHaveBeenCalled();
  });

  it('updateRoute sets the route key on the next microtask', async () => {
    const c = makeLayout();
    c.updateRoute(outlet('analytics'));
    await Promise.resolve();
    expect(c.routeKey()).toBe('analytics');
  });
});
