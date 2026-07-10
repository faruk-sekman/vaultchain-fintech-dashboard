/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { TranslateService } from '@ngx-translate/core';
import {
  appConfig,
  ignoreTranslationBundleError,
  loadInitialTranslations,
  resolveBootstrapLanguage,
  resolveBootstrapLocaleId,
  rehydrateSessionInitializer,
} from './app.config';

describe('appConfig', () => {
  afterEach(() => {
    vi.doUnmock('../environments/environment');
    vi.resetModules();
  });

  it('defines providers', () => {
    expect(appConfig.providers?.length).toBeGreaterThan(0);
  });

  it('omits store devtools provider in production configuration', async () => {
    vi.resetModules();
    vi.doMock('../environments/environment', () => ({
      environment: {
        production: true,
        apiBaseUrl: 'https://example.invalid',
        defaultLanguage: 'tr',
      },
    }));

    const { appConfig: productionConfig } = await import('./app.config');

    expect(productionConfig.providers?.length).toBe((appConfig.providers?.length ?? 0) - 1);
  });

  it('resolves English as the bootstrap fallback when the environment default is en', async () => {
    vi.resetModules();
    vi.doMock('../environments/environment', () => ({
      environment: {
        production: false,
        apiBaseUrl: 'https://example.invalid',
        defaultLanguage: 'en',
        enableDevtools: false,
      },
    }));

    const { resolveBootstrapLanguage: resolveWithEnglishDefault } = await import('./app.config');

    expect(resolveWithEnglishDefault()).toBe('en');
  });
});

describe('resolveBootstrapLocaleId', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('maps a persisted Turkish language to tr-TR', () => {
    localStorage.setItem('lang', 'tr');
    expect(resolveBootstrapLanguage()).toBe('tr');
    expect(resolveBootstrapLocaleId()).toBe('tr-TR');
  });

  it('maps a persisted English language to en-US', () => {
    localStorage.setItem('lang', 'en');
    expect(resolveBootstrapLanguage()).toBe('en');
    expect(resolveBootstrapLocaleId()).toBe('en-US');
  });

  it('falls back to the environment default (tr → tr-TR) when nothing is persisted', () => {
    expect(resolveBootstrapLocaleId()).toBe('tr-TR');
  });

  it('ignores an invalid persisted value and uses the environment default', () => {
    localStorage.setItem('lang', 'fr');
    expect(resolveBootstrapLocaleId()).toBe('tr-TR');
  });

  it('falls back to the environment default when storage is unavailable', () => {
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    try {
      expect(resolveBootstrapLocaleId()).toBe('tr-TR');
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });
});

describe('loadInitialTranslations', () => {
  function run(i18n: Partial<TranslateService>): Promise<unknown> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: TranslateService, useValue: i18n }] });
    return TestBed.runInInjectionContext(() => loadInitialTranslations());
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('loads the persisted language before bootstrap completes', async () => {
    localStorage.setItem('lang', 'en');
    const use = vi.fn(() => of({}));
    const setTranslation = vi.fn();

    await run({ setTranslation, use } as unknown as TranslateService);

    expect(setTranslation).toHaveBeenCalledWith('tr', expect.any(Object));
    expect(setTranslation).toHaveBeenCalledWith('en', expect.any(Object));
    expect(use).toHaveBeenCalledWith('en');
  });

  it('swallows translation-load errors so the app can still render a recoverable shell', async () => {
    const setTranslation = vi.fn();
    const use = vi.fn(() => throwError(() => new Error('i18n asset unavailable')));

    await expect(run({ setTranslation, use } as unknown as TranslateService)).resolves.toBeNull();
  });

  it('routes a failed bundle load through ignoreTranslationBundleError (null, no crash)', async () => {
    // Deliberately NOT a vi.spyOn(Promise, 'all') mock: evaluating the Promise.all ARGUMENTS
    // kicks off the dynamic imports first, and Vite's module runner consumes a
    // mockImplementationOnce internally — that variant silently passed via the HAPPY path
    // while the catch stayed unexecuted. Assert the exported catch handler on a real
    // rejection chain instead, exactly as it is wired in loadInitialTranslations.
    await expect(
      Promise.reject(new Error('missing bundle')).catch(ignoreTranslationBundleError),
    ).resolves.toBeNull();
  });
});

describe('rehydrateSessionInitializer', () => {
  function run(auth: Partial<AuthService>): Promise<unknown> | void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: auth }] });
    return TestBed.runInInjectionContext(() => rehydrateSessionInitializer());
  }

  it('skips the refresh probe when there is no session hint', () => {
    const refresh = vi.fn();
    expect(run({ hasSessionHint: () => false, refresh })).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('probes /auth/refresh when a session hint exists', async () => {
    const refresh = vi.fn(() => of({}));
    await run({ hasSessionHint: () => true, refresh });
    expect(refresh).toHaveBeenCalledWith(true);
  });

  it('swallows a refresh error so bootstrap always resolves', async () => {
    const refresh = vi.fn(() => throwError(() => new Error('expired')));
    await expect(run({ hasSessionHint: () => true, refresh })).resolves.toBeNull();
  });
});
