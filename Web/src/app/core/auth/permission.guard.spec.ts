/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the permission guard, including the hard-reload race: the guard must AWAIT
 * the principal when it hasn't loaded yet, rather than rejecting a legitimate admin synchronously.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject, isObservable, lastValueFrom, of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { ToastService } from '@core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';
import { permissionGuard } from './permission.guard';

interface AuthStub {
  isAuthenticated: () => boolean;
  principal: () => unknown;
  hasPermission: (p: string) => boolean;
  loadPrincipal: ReturnType<typeof vi.fn>;
}

function setup(auth: Partial<AuthStub>) {
  const router = { createUrlTree: vi.fn((commands: unknown[]) => ({ tree: commands })) };
  const toast = { error: vi.fn() };
  const i18n = { instant: vi.fn((k: string) => k) };
  const authStub: AuthStub = {
    isAuthenticated: () => true,
    principal: () => ({ user: {}, permissions: [] }),
    hasPermission: () => false,
    loadPrincipal: vi.fn(() => of({ user: {}, permissions: [] })),
    ...auth,
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: authStub },
      { provide: Router, useValue: router },
      { provide: ToastService, useValue: toast },
      { provide: TranslateService, useValue: i18n },
    ],
  });

  const run = () =>
    TestBed.runInInjectionContext(() =>
      permissionGuard('customers.manage')({} as never, { url: '/customers/1/edit' } as never),
    );

  return { run, router, toast, i18n, authStub };
}

describe('permissionGuard', () => {
  it('(a) allows an authenticated operator who holds the permission (principal already loaded)', () => {
    const { run, authStub } = setup({ hasPermission: () => true });
    const result = run();
    expect(result).toBe(true);
    // Principal already present → no extra /auth/me request.
    expect(authStub.loadPrincipal).not.toHaveBeenCalled();
  });

  it('(b) authenticated without the permission → /customers UrlTree + localized toast', () => {
    const { run, router, toast, i18n } = setup({ hasPermission: () => false });
    const result = run();
    expect(router.createUrlTree).toHaveBeenCalledWith(['/customers']);
    expect(result).toEqual({ tree: ['/customers'] });
    expect(i18n.instant).toHaveBeenCalledWith('errors.forbidden');
    expect(toast.error).toHaveBeenCalledWith('errors.forbidden');
  });

  it('(c) unauthenticated → /login UrlTree with the attempted returnUrl', () => {
    const { run, router } = setup({ isAuthenticated: () => false });
    const result = run();
    expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/customers/1/edit' },
    });
    expect(result).toEqual({ tree: ['/login'] });
  });

  describe('hard-reload race: principal not loaded yet', () => {
    it('AWAITS loadPrincipal() then allows the admin (would wrongly reject if read synchronously)', async () => {
      // hasPermission flips to true only AFTER loadPrincipal resolves — proving the guard waits.
      let loaded = false;
      const principal = new Subject<unknown>();
      const { run, authStub } = setup({
        principal: () => null,
        hasPermission: () => loaded,
        loadPrincipal: vi.fn(() => principal.asObservable()),
      });

      const result = run();
      expect(isObservable(result)).toBe(true);
      expect(authStub.loadPrincipal).toHaveBeenCalledTimes(1);

      // Subscribe BEFORE the principal resolves (the real reload sequence), then resolve it; only
      // now does hasPermission return true — proving the guard waited rather than judging early.
      const settled = lastValueFrom(result as never);
      loaded = true;
      principal.next({ user: {}, permissions: ['customers.manage'] });
      principal.complete();

      await expect(settled).resolves.toBe(true);
    });

    it('AWAITS loadPrincipal() then redirects a still-under-privileged operator to /customers + toast', async () => {
      const { run, router, toast } = setup({
        principal: () => null,
        hasPermission: () => false,
        loadPrincipal: vi.fn(() => of({ user: {}, permissions: ['customers.read'] })),
      });

      const result = run();
      await expect(lastValueFrom(result as never)).resolves.toEqual({ tree: ['/customers'] });
      expect(router.createUrlTree).toHaveBeenCalledWith(['/customers']);
      expect(toast.error).toHaveBeenCalledWith('errors.forbidden');
    });

    it('fails CLOSED to /login when loadPrincipal() errors (session unconfirmable)', async () => {
      const { run, router } = setup({
        principal: () => null,
        hasPermission: () => true, // even if it WOULD pass, a failed load must not allow access
        loadPrincipal: vi.fn(() => throwError(() => new Error('me failed'))),
      });

      const result = run();
      await expect(lastValueFrom(result as never)).resolves.toEqual({ tree: ['/login'] });
      expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/customers/1/edit' },
      });
    });
  });
});
