/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared pre-auth HEADER CONTROLS — the top-right language switch (TR/EN) + light/dark theme toggle,
 * reused identically by the login and password-reset screens (the same component, per request). Owns
 * the language persistence (ngx-translate + `localStorage['lang']` + `<html lang>`) and delegates the
 * theme flip to ThemeService. 2-mode sun/moon toggle — the login behaviour, now the single standard
 * for both auth screens.
 *
 * Standalone + OnPush. `--ld-*` design tokens are inherited from the host screen (.login / .forgot).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ThemeService } from '@core/services/theme.service';

@Component({
  selector: 'app-auth-header-controls',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslateModule],
  templateUrl: './auth-header-controls.component.html',
  styleUrl: './auth-header-controls.component.scss',
})
export class AuthHeaderControlsComponent {
  private readonly i18n = inject(TranslateService);
  private readonly themeService = inject(ThemeService);

  /** Active resolved theme ('light' | 'dark') — drives the sun/moon icon + aria-pressed. */
  readonly theme = this.themeService.theme;

  /** The active UI language (defaults to Turkish, the app default). */
  currentLang(): 'tr' | 'en' {
    return this.i18n.currentLang === 'en' ? 'en' : 'tr';
  }

  /**
   * Pre-auth language switch: apply via ngx-translate, persist to `localStorage['lang']`, and reflect
   * on `<html lang>` (WCAG 3.1.1).
   */
  switchLang(lang: 'tr' | 'en'): void {
    this.i18n.use(lang);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('lang', lang);
    } catch {
      // Preference persistence is non-critical; the choice stays active in memory.
    }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }

  /** Pre-auth light/dark toggle (delegates to ThemeService, which owns persistence). */
  toggleTheme(): void {
    this.themeService.toggleTheme();
  }
}
