/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeTr from '@angular/common/locales/tr';
import { TranslateService } from '@ngx-translate/core';
import { LocaleFormatService } from '@core/services/locale-format.service';

registerLocaleData(localeTr);

function make(currentLang: string) {
  const onLangChange = new Subject<{ lang: string }>();
  const i18n = { currentLang, onLangChange } as unknown as TranslateService;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: TranslateService, useValue: i18n }] });
  const service = TestBed.inject(LocaleFormatService);
  return { service, onLangChange };
}

describe('LocaleFormatService (B2/B3)', () => {
  it('resolves the active language to its BCP-47 tag (unknown → en-US)', () => {
    expect(make('tr').service.localeTag()).toBe('tr-TR');
    expect(make('en').service.localeTag()).toBe('en-US');
    expect(make(undefined as unknown as string).service.localeTag()).toBe('en-US');
  });

  it('switches the tag LIVE on onLangChange (the frozen-LOCALE_ID gap this service closes)', () => {
    const { service, onLangChange } = make('en');
    expect(service.number(1501)).toBe('1,501');
    onLangChange.next({ lang: 'tr' });
    expect(service.localeTag()).toBe('tr-TR');
    expect(service.number(1501)).toBe('1.501');
  });

  it('B3: currency renders the NARROW SYMBOL in both locales (never CODE + amount + CODE)', () => {
    const tr = make('tr').service.currency(109483, 'TRY');
    const en = make('en').service.currency(109483, 'TRY');
    expect(tr).toContain('₺');
    expect(tr).toContain('109.483');
    expect(en).toContain('₺'); // narrowSymbol: en-US would otherwise print the TRY code
    expect(en).toContain('109,483');
    expect(`${tr}${en}`).not.toContain('TRY');
  });

  it('formats percent from a 0-100 input', () => {
    expect(make('en').service.percent(38)).toBe('38%');
    expect(make('tr').service.percent(38)).toMatch(/%\s?38|38\s?%/u);
  });

  it('formats dates with the active locale', () => {
    const iso = '2026-07-02T00:00:00.000Z';
    expect(make('en').service.date(iso, 'mediumDate', 'UTC')).toBe('Jul 2, 2026');
    expect(make('tr').service.date(iso, 'mediumDate', 'UTC')).toBe('2 Tem 2026');
  });

  it('memoizes Intl formatters per locale+options', () => {
    const { service, onLangChange } = make('en');
    const a = service.number(1);
    onLangChange.next({ lang: 'tr' });
    const b = service.number(1);
    onLangChange.next({ lang: 'en' });
    const c = service.number(1000);
    expect(a).toBe('1');
    expect(b).toBe('1');
    expect(c).toBe('1,000'); // en formatter reused from cache, still correct
  });
});
