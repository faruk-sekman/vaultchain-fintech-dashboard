/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { HttpContextToken } from '@angular/common/http';

/**
 * Marks an HTTP request whose failures must NOT raise a global error toast — either because the
 * failure is benign (the bootstrap session probe) or because the caller already surfaces it inline
 * (e.g. the login form's ui-alert banner), so a global toast would be a duplicate notification.
 *
 * Used by the bootstrap auth probe: on every app load the access token is
 * gone (it lives in memory only), so `app.config` fires a silent `/auth/refresh` to rehydrate it from
 * the httpOnly cookie. For an anonymous visitor (or an expired cookie) that call 401s — which is
 * normal, not an error the operator should see flashed on the login screen. `errorInterceptor` checks
 * this flag and stays quiet; the bootstrap initializer swallows the rejection and the guard routes to
 * /login. Genuine mid-session expiry (refresh triggered by `authInterceptor`) does NOT set the flag,
 * so it still surfaces the `sessionExpired` notification as before.
 */
export const SILENT_REQUEST = new HttpContextToken<boolean>(() => false);
