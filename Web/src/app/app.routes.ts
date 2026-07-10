/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { authGuard } from '@core/auth/auth.guard';
import { mfaPendingGuard } from '@core/auth/mfa-pending.guard';
import { permissionGuard } from '@core/auth/permission.guard';
import { provideDashboardState } from '@features/dashboard/dashboard.providers';
import { provideDashboardMetricsState } from '@core/state/dashboard-metrics';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('@features/auth/pages/login/login.component').then(m => m.LoginComponent),
  },
  {
    // The MFA challenge step, reachable only mid-login (mfaPendingGuard redirects a
    // direct visit with no pending challenge to /login). Lazy so it never weighs on first paint.
    path: 'mfa/verify',
    canActivate: [mfaPendingGuard],
    loadComponent: () =>
      import('@features/auth/pages/mfa-verify/mfa-verify.component').then(
        m => m.MfaVerifyComponent,
      ),
  },
  {
    // On-screen password reset (email → 2FA → new password) wired to the real backend
    // (POST /auth/password/reset/initiate|verify); lazy so it never weighs on first paint.
    path: 'forgot-password',
    loadComponent: () =>
      import('@features/auth/pages/forgot-password/forgot-password.component').then(
        m => m.ForgotPasswordComponent,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./layout/main-layout/main-layout.component').then(m => m.MainLayoutComponent),
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: 'dashboard',
      },
      {
        path: 'dashboard',
        data: { titleKey: 'nav.dashboard' },
        // O-6: the dashboardStats + latestCustomer slices load with this route, not at bootstrap.
        providers: [provideDashboardState()],
        loadComponent: () =>
          import('@features/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
      {
        path: 'customers',
        data: { titleKey: 'customers.title' },
        loadChildren: () =>
          import('@features/customers/customer.routes').then(m => m.customerRoutes),
      },
      {
        path: 'analytics',
        data: { titleKey: 'analytics.title' },
        // O-6: analytics consumes the SAME shared dashboardStats slice as the dashboard route, so it
        // self-provides it (idempotent registration) rather than relying on an eager root slice.
        providers: [provideDashboardMetricsState()],
        loadComponent: () =>
          import('@features/analytics/analytics.component').then(m => m.AnalyticsComponent),
      },
      {
        // The full, paged notifications history. Authed (no extra permission — every
        // operator has their own recipient-scoped feed). Lazy so it never weighs on first paint.
        path: 'notifications',
        data: { titleKey: 'notifications.page.title' },
        loadComponent: () =>
          import('@features/notifications/notifications.component').then(
            m => m.NotificationsComponent,
          ),
      },
      {
        // The preserved `/settings/mfa` deep-link now resolves to the Settings shell with
        // the enrolment wizard AUTO-OPENED in its drawer on the password step (NOT a detached full page).
        // `mfaAutoOpen` is read by SettingsComponent to land on Security + open the drawer; the lazy
        // boundary is kept (Settings is itself lazy). No NEW top-level route surface beyond this one.
        path: 'settings/mfa',
        data: { titleKey: 'mfa.setup.pageTitle', mfaAutoOpen: true },
        loadComponent: () =>
          import('@features/settings/pages/settings/settings.component').then(
            m => m.SettingsComponent,
          ),
      },
      {
        // Administrator-only MFA reset. Defense-in-depth: the BE gates
        // POST /auth/mfa/admin-reset on `auth.mfa.admin_reset`; this closes the URL-level gap so an
        // operator/auditor cannot reach the screen by deep link.
        path: 'settings/admin-mfa-reset',
        canActivate: [permissionGuard('auth.mfa.admin_reset')],
        data: { titleKey: 'mfa.adminReset.pageTitle' },
        loadComponent: () =>
          import('@features/settings/pages/admin-mfa-reset/admin-mfa-reset.component').then(
            m => m.AdminMfaResetComponent,
          ),
      },
      {
        // Administrator-only password reset. A root-level route (a sibling of
        // `notifications`, NOT nested under `settings`) so the sidebar's Settings entry keeps a clean,
        // prefix-based active state for its own sub-pages. Defense-in-depth: the BE gates
        // POST /auth/password/admin-reset on `auth.password.admin_reset`; this closes the URL-level gap
        // so an operator/auditor cannot reach the screen by deep link. Lazy so it never weighs on first
        // paint.
        path: 'admin-password-reset',
        canActivate: [permissionGuard('auth.password.admin_reset')],
        data: { titleKey: 'password.adminReset.pageTitle' },
        loadComponent: () =>
          import('@features/settings/pages/admin-password-reset/admin-password-reset.component').then(
            m => m.AdminPasswordResetComponent,
          ),
      },
      {
        // EK-2: the standalone reset-requests page merged INTO /admin-password-reset (one admin
        // recovery page — the review queue is now its bottom section). Old bookmarks keep working:
        // the bare list URL redirects to the merged page; the permission guard lives on the TARGET
        // route, so the gate is unchanged. pathMatch 'full' keeps this from prefix-shadowing the
        // sibling `:id` redirect below.
        path: 'admin-reset-requests',
        pathMatch: 'full',
        redirectTo: '/admin-password-reset',
      },
      {
        // EK-2: the old `:id` deep link (reset-request SECURITY_ALERT notifications, bookmarks)
        // carries the request over as the `?request=` query param the embedded section preselects.
        // Modern redirectTo FUNCTION form: it runs in an injection context, so the Router builds a
        // UrlTree WITH query params (a redirect string cannot carry them).
        path: 'admin-reset-requests/:id',
        redirectTo: ({ params }) =>
          inject(Router).createUrlTree(['/admin-password-reset'], {
            queryParams: { request: params['id'] },
          }),
      },
      {
        path: 'settings',
        data: { titleKey: 'settings.title' },
        loadComponent: () =>
          import('@features/settings/pages/settings/settings.component').then(
            m => m.SettingsComponent,
          ),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
