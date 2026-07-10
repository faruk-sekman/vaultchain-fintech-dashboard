/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { environment } from '../environments/environment';
import { registerLocaleData } from '@angular/common';
import localeTr from '@angular/common/locales/tr';
import localeEn from '@angular/common/locales/en';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  constructor(private readonly i18n: TranslateService) {
    registerLocaleData(localeTr);
    registerLocaleData(localeEn);
  }

  ngOnInit(): void {
    const lang = this.readSavedLanguage() ?? environment.defaultLanguage;
    this.i18n.use(lang);
    this.applyDocumentLang(lang);
  }

  /**
   * Reflects the active language on `<html lang>` so assistive tech uses the correct
   * pronunciation (WCAG 3.1.1). Mirrors `ThemeService`'s `documentElement` pattern and is
   * guarded for headless/SSR contexts where `document` is absent.
   */
  private applyDocumentLang(lang: string): void {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
  }

  private readSavedLanguage(): 'en' | 'tr' | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const saved = localStorage.getItem('lang');
      if (saved === 'tr' || saved === 'en') return saved;
      return null;
    } catch {
      return null;
    }
  }
}
