/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import {
  ApplicationConfig,
  ErrorHandler,
  LOCALE_ID,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideToastr } from 'ngx-toastr';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideStore } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';
import { provideStoreDevtools } from '@ngrx/store-devtools';
import { firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { routes } from './app.routes';
import { AuthService } from '@core/auth/auth.service';
import { UiToastComponent } from '@shared/components/ui-toast/ui-toast.component';
import { loadingInterceptor } from '@core/interceptors/loading.interceptor';
import { authInterceptor } from '@core/interceptors/auth.interceptor';
import { errorInterceptor } from '@core/interceptors/error.interceptor';
import { GlobalErrorHandler } from '@core/services/global-error-handler';

import {
  provideTranslateService,
  TranslateService,
  type TranslationObject,
} from '@ngx-translate/core';
import { environment } from '../environments/environment';
import { AppErrorEffects } from '@core/state/app-error.effects';

/** Supported UI languages → their BCP-47 locale (matches `ui-form`/`customer-detail`). */
const LOCALE_BY_LANG: Record<'tr' | 'en', string> = { tr: 'tr-TR', en: 'en-US' };

function readSavedLanguage(): 'tr' | 'en' | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('lang');
      if (saved === 'tr' || saved === 'en') return saved;
    }
  } catch {
    // Storage unavailable (e.g. SSR/headless) — keep the environment default.
  }
  return null;
}

export function resolveBootstrapLanguage(): 'tr' | 'en' {
  return readSavedLanguage() ?? (environment.defaultLanguage === 'en' ? 'en' : 'tr');
}

/**
 * Resolves the bootstrap `LOCALE_ID` from the persisted language (mirrors
 * `App.readSavedLanguage()`), falling back to `environment.defaultLanguage`.
 *
 * Angular resolves `LOCALE_ID` ONCE at bootstrap, so this fixes the locale used by
 * pipe formatting (`{{ x | date }}`, `{{ n | number }}`) and `formatDate(..., LOCALE_ID)`
 * for the language the app loads in. A runtime `i18n.use()` switch does NOT re-resolve this
 * token — pipe/`formatDate` output reformats on the next reload; call sites that must
 * reformat live (e.g. `formatCount`) read `i18n.currentLang` directly instead.
 */
export function resolveBootstrapLocaleId(): string {
  return LOCALE_BY_LANG[resolveBootstrapLanguage()];
}

// The access token lives in memory only (never web storage). On a full
// page reload it is gone, so silently re-obtain it from the httpOnly `ftd_refresh` cookie BEFORE
// route guards run — `authGuard` reads `isAuthenticated()` synchronously, so doing this in a
// component would bounce a valid operator to /login on every reload. Errors are swallowed so
// bootstrap always resolves: no/expired cookie simply means "unauthenticated" → the guard sends
// the operator to /login. Token values are never logged. Extracted (named) so it is unit-testable.
export function rehydrateSessionInitializer(): Promise<unknown> | void {
  const auth = inject(AuthService);
  // Only probe `/auth/refresh` when this browser has logged in before (session hint). An anonymous
  // first visit skips the probe entirely → no `/auth/refresh` call and no spurious 401 on the login
  // screen. A returning session is still restored; a stale hint 401s once then self-clears.
  if (!auth.hasSessionHint()) return;
  return firstValueFrom(auth.refresh(true).pipe(catchError(() => of(null))));
}

async function loadTranslationBundle(lang: 'tr' | 'en'): Promise<TranslationObject> {
  const bundle =
    lang === 'en' ? await import('../assets/i18n/en.json') : await import('../assets/i18n/tr.json');
  return bundle.default as TranslationObject;
}

export function ignoreTranslationBundleError(): null {
  return null;
}

export function loadInitialTranslations(): Promise<unknown> {
  const i18n = inject(TranslateService);
  const lang = resolveBootstrapLanguage();

  return Promise.all([loadTranslationBundle('tr'), loadTranslationBundle('en')])
    .then(([tr, en]) => {
      i18n.setTranslation('tr', tr);
      i18n.setTranslation('en', en);
    })
    .catch(ignoreTranslationBundleError)
    .then(() => firstValueFrom(i18n.use(lang).pipe(catchError(() => of(null)))));
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([loadingInterceptor, authInterceptor, errorInterceptor])),
    provideAppInitializer(loadInitialTranslations),
    provideAppInitializer(rehydrateSessionInitializer),
    provideAnimations(),
    // The toast body is the shared app-ui-alert (UiToastComponent) — a toast IS our alert design.
    // No iconClasses/closeButton: the component derives the icon from the ui-alert variant and renders
    // ui-alert's own dismiss. Container/float styling is in src/styles/_toastr.scss.
    provideToastr({
      timeOut: 3200,
      positionClass: 'toast-top-right',
      preventDuplicates: true,
      toastComponent: UiToastComponent,
    }),
    // O-6 (lazy NgRx feature-state isolation): the root registers ONLY the empty store skeleton
    // and the cross-cutting `AppErrorEffects` (no reducer; listens to every `*Failure` action).
    // Each feature slice — customers/transactions/kycVerifications/latestCustomer/dashboardStats —
    // now self-registers via `provideState`/`provideEffects` on its own lazy route, so none of them
    // (or their effects) instantiate at app bootstrap.
    provideStore({}),
    provideEffects([AppErrorEffects]),
    ...(environment.enableDevtools ? [provideStoreDevtools({ maxAge: 25 })] : []),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    // Locale used by date/number pipes + `formatDate(..., LOCALE_ID)`. Bound to the persisted
    // language at bootstrap (tr → tr-TR, en → en-US); see `resolveBootstrapLocaleId`.
    { provide: LOCALE_ID, useFactory: resolveBootstrapLocaleId },
    // Translations are registered by loadInitialTranslations from lazy JSON chunks, not root-bundle JSON.
    provideTranslateService({
      fallbackLang: environment.defaultLanguage,
      lang: environment.defaultLanguage,
    }),
  ],
};
