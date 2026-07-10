/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Permission route guard: a factory that gates a route on a single permission code so
 * an operator without it cannot reach a privileged screen by URL (the action buttons are already
 * gated by `AuthService.hasPermission`, and the backend returns 403 — this closes the URL-level gap).
 *
 * Hard-reload race (verified): only the access token is persisted across a reload; the principal
 * (and therefore its permissions) is loaded asynchronously via `GET /auth/me`. On a deep-link reload
 * of a guarded route this guard runs BEFORE `MainLayoutComponent.ngOnInit` fires `loadPrincipal()`,
 * so reading `hasPermission` synchronously would reject a legitimate admin. The guard therefore
 * AWAITS the principal: if it isn't loaded yet it triggers `loadPrincipal()`, then evaluates. A failed
 * principal load fails CLOSED (redirect, not allow). When the principal is already present (in-app
 * navigation) it resolves synchronously without an extra request.
 */
import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import { AuthService } from './auth.service';
import { ToastService } from '@core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';

export function permissionGuard(permission: string): CanActivateFn {
  return (_route, state): boolean | UrlTree | Observable<boolean | UrlTree> => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const toast = inject(ToastService);
    const i18n = inject(TranslateService);

    // Not signed in at all → defer to the login flow, preserving where they were headed.
    if (!auth.isAuthenticated()) {
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    }

    const decide = (): boolean | UrlTree => {
      if (auth.hasPermission(permission)) return true;
      // Authenticated but under-privileged: send back to the safe landing page with a localized toast.
      toast.error(i18n.instant('errors.forbidden'));
      return router.createUrlTree(['/customers']);
    };

    // In-app navigation: the principal is already loaded, so decide synchronously (no extra request).
    if (auth.principal()) return decide();

    // Hard-reload / deep-link: wait for the principal before judging permissions, so an admin is
    // never wrongly rejected. A load failure fails closed (the auth interceptor handles a real 401).
    return auth.loadPrincipal().pipe(
      map(() => decide()),
      catchError(() =>
        of(router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } })),
      ),
    );
  };
}
