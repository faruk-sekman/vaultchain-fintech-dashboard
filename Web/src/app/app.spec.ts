/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

class TranslateMock {
  use = vi.fn();
  setTranslation = vi.fn();
}

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses saved language if present', () => {
    localStorage.setItem('lang', 'tr');
    const i18n = new TranslateMock();
    const app = new App(i18n as any);

    app.ngOnInit();
    expect(i18n.use).toHaveBeenCalledWith('tr');
  });

  it('falls back to default language when saved is invalid', () => {
    localStorage.setItem('lang', 'fr');
    const i18n = new TranslateMock();
    const app = new App(i18n as any);

    app.ngOnInit();
    expect(i18n.use).toHaveBeenCalledWith('tr');
  });

  it('falls back when localStorage is unavailable', () => {
    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = undefined;
    const i18n = new TranslateMock();
    const app = new App(i18n as any);

    app.ngOnInit();
    (globalThis as any).localStorage = originalLocalStorage;

    expect(i18n.use).toHaveBeenCalledWith('tr');
  });

  it('reflects the active language on <html lang> at bootstrap (WCAG 3.1.1)', () => {
    localStorage.setItem('lang', 'tr');
    const app = new App(new TranslateMock() as any);

    app.ngOnInit();

    expect(document.documentElement.lang).toBe('tr');
  });

  it('does not crash when document is unavailable during bootstrap', () => {
    vi.stubGlobal('document', undefined);
    const i18n = new TranslateMock();
    const app = new App(i18n as any);

    expect(() => app.ngOnInit()).not.toThrow();
    expect(i18n.use).toHaveBeenCalledWith('tr');
  });

  it('falls back to the default language when reading localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const i18n = new TranslateMock();
    const app = new App(i18n as any);

    app.ngOnInit();

    expect(i18n.use).toHaveBeenCalledWith('tr');
  });
});
