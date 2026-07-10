/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { AuthHeaderControlsComponent } from './auth-header-controls.component';
import { ThemeService } from '@core/services/theme.service';
import controlsTemplate from './auth-header-controls.component.html?raw';

function setup() {
  const i18n = { currentLang: 'tr', use: vi.fn() };
  const themeService = { theme: () => 'light', toggleTheme: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: TranslateService, useValue: i18n },
      { provide: ThemeService, useValue: themeService },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new AuthHeaderControlsComponent());
  return { component, i18n, themeService };
}

describe('AuthHeaderControlsComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('switchLang applies the language (ngx-translate), persists it, and sets <html lang>', () => {
    const { component, i18n } = setup();
    component.switchLang('en');
    expect(i18n.use).toHaveBeenCalledWith('en');
    expect(localStorage.getItem('lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('currentLang reads the active ngx-translate language (defaults to tr)', () => {
    const { component } = setup();
    expect(component.currentLang()).toBe('tr');
  });

  it('currentLang returns "en" when ngx-translate is set to English (the === "en" branch)', () => {
    const i18n = { currentLang: 'en', use: vi.fn() };
    const themeService = { theme: () => 'dark', toggleTheme: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: TranslateService, useValue: i18n },
        { provide: ThemeService, useValue: themeService },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new AuthHeaderControlsComponent());
    expect(component.currentLang()).toBe('en');
  });

  it('switchLang to "tr" applies + persists + reflects <html lang> (both string branches)', () => {
    const { component, i18n } = setup();
    component.switchLang('tr');
    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(localStorage.getItem('lang')).toBe('tr');
    expect(document.documentElement.lang).toBe('tr');
  });

  it('switchLang keeps working when localStorage.setItem throws (persistence is non-critical)', () => {
    const { component, i18n } = setup();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      component.switchLang('en');
      // The language still applies + reflects on <html lang> despite the storage failure.
      expect(i18n.use).toHaveBeenCalledWith('en');
      expect(document.documentElement.lang).toBe('en');
    } finally {
      spy.mockRestore();
    }
  });

  it('switchLang skips storage + <html lang> when those globals are absent (SSR guards)', () => {
    const { component, i18n } = setup();
    const originalLs = (globalThis as { localStorage?: Storage }).localStorage;
    const originalDoc = (globalThis as { document?: Document }).document;
    // Force the `typeof … === 'undefined'` guards down their false branch (no DOM, no storage).
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    (globalThis as { document?: Document }).document = undefined;
    try {
      expect(() => component.switchLang('en')).not.toThrow();
      expect(i18n.use).toHaveBeenCalledWith('en'); // the language switch itself still runs
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = originalLs;
      (globalThis as { document?: Document }).document = originalDoc;
    }
  });

  it('toggleTheme delegates to ThemeService', () => {
    const { component, themeService } = setup();
    component.toggleTheme();
    expect(themeService.toggleTheme).toHaveBeenCalled();
  });

  it('renders a 2-mode (sun/moon) toggle and a TR/EN segmented switch', () => {
    const doc = new DOMParser().parseFromString(controlsTemplate, 'text/html');
    expect(doc.querySelectorAll('button.auth-controls__lang-btn').length).toBe(2);
    expect(doc.querySelector('button.auth-controls__theme')).not.toBeNull();
    expect(controlsTemplate).toContain("switchLang('en')");
    expect(controlsTemplate).toContain('toggleTheme()');
    // 2-mode: a single light/dark branch keyed on theme() === 'dark' (no 3-mode system/monitor).
    expect(controlsTemplate).toContain("theme() === 'dark'");
    expect(controlsTemplate).not.toContain('themeMode()');
  });
});
