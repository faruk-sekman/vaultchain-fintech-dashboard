/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Route guard: allow authenticated operators; otherwise redirect to /login,
 * preserving the attempted URL as `returnUrl`. Defense-in-depth behind the backend's own authz.
 */
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
