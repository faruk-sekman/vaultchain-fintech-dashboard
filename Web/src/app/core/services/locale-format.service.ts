/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Central locale-aware formatting (B2/B3, bugfix-backlog-2026-07). ONE source of truth for how
 * numbers, currencies, percentages, and dates render, driven by the ACTIVE UI language (live on a
 * TR↔EN switch — unlike `LOCALE_ID`, which Angular resolves once at bootstrap). Before this
 * service the same screen mixed three regimes: bootstrap-frozen pipes, ad-hoc
 * `i18n.currentLang` formatters, and `Intl.NumberFormat(undefined, …)` (the BROWSER locale).
 *
 * Currency policy (B3): monetary values render with the locale's SYMBOL notation
 * (`₺109.483,00` / `₺109,483.00`), never `CODE + amount + CODE`. A standalone currency CODE
 * (chip/label) is legitimate only where no formatted amount already communicates it.
 */
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { formatDate } from '@angular/common';
import { TranslateService } from '@ngx-translate/core';

const LOCALE_BY_LANG: Record<string, string> = { tr: 'tr-TR', en: 'en-US' };

@Injectable({ providedIn: 'root' })
export class LocaleFormatService {
  /**
   * Optional so the service stays constructible in bare TestBed setups (dumb shared components
   * like the charts had zero deps before B2). The real app ALWAYS provides TranslateService
   * (`provideTranslateService` in app.config); without it the service pins en-US.
   */
  private readonly i18n = inject(TranslateService, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** Memoized Intl formatters, keyed by locale + options — avoids per-cell allocation. */
  private readonly formatters = new Map<string, Intl.NumberFormat>();

  private readonly _localeTag = signal(this.resolve(this.i18n?.currentLang));

  /** Reactive BCP-47 tag of the ACTIVE UI language (`tr-TR` | `en-US`); updates live on switch. */
  readonly localeTag = this._localeTag.asReadonly();

  constructor() {
    // `?.` on onLangChange too: lean unit-test doubles often stub only `instant`/`currentLang`.
    const sub = this.i18n?.onLangChange?.subscribe(event => {
      this._localeTag.set(this.resolve(event.lang));
    });
    this.destroyRef.onDestroy(() => sub?.unsubscribe());
  }

  /** Grouped plain number in the active locale (`1.501` / `1,501`). */
  number(value: number, options?: Intl.NumberFormatOptions): string {
    return this.formatter(options ?? {}).format(value);
  }

  /**
   * Monetary amount with SYMBOL notation (B3): `₺109.483,00` (tr) / `₺109,483.00` (en).
   * `narrowSymbol` keeps the symbol stable across locales — en-US CLDR would otherwise print the
   * CODE for TRY ("TRY 109,483.00"), recreating the mixed code-vs-symbol inconsistency.
   */
  currency(value: number, currencyCode: string): string {
    return this.formatter({
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
    }).format(value);
  }

  /** Percentage from a 0–100 value (`%38` / `38%`). */
  percent(value: number, maximumFractionDigits = 0): string {
    return this.formatter({ style: 'percent', maximumFractionDigits }).format(value / 100);
  }

  /** Date in an Angular `formatDate` style (`'shortDate' | 'mediumDate' | 'short' | …`). */
  date(value: string | number | Date, format: string, timezone?: string): string {
    return formatDate(value, format, this._localeTag(), timezone);
  }

  private resolve(lang: string | undefined): string {
    return LOCALE_BY_LANG[lang ?? ''] ?? LOCALE_BY_LANG['en'];
  }

  private formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
    const tag = this._localeTag();
    const key = `${tag}|${JSON.stringify(options)}`;
    let formatter = this.formatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(tag, options);
      this.formatters.set(key, formatter);
    }
    return formatter;
  }
}
