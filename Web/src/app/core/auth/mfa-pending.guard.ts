/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Route guard for `/mfa/verify` (AC9). The verify screen is reachable ONLY
 * mid-login, when `login()` returned `mfa_required` and `AuthService.mfaPending` is true. A direct
 * navigation with no pending challenge (e.g. a bookmarked URL, a hard reload that dropped the
 * in-memory state) redirects to `/login` — the screen never renders without a live challenge.
 */
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const mfaPendingGuard: CanActivateFn = route => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.mfaPending()) return true;
  // Preserve any returnUrl so a fresh login still lands where the operator was headed.
  const returnUrl = route.queryParamMap.get('returnUrl');
  return router.createUrlTree(['/login'], returnUrl ? { queryParams: { returnUrl } } : {});
};
