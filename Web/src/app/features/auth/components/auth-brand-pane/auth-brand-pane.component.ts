/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared auth BRAND PANE — the animated left value panel reused by both the
 * login and the password-reset screens. Owns the decorative layer (drifting orbs, scrolling area
 * chart, pulsing brand glyph with rings) and a typewriter hero CAROUSEL; the COPY is injected per
 * screen via @Input()s so login shows its 3-slide welcome and forgot shows its own message. With a
 * single slide the typewriter types once and stops (no auto-advance, no dots) — a calm static lockup.
 *
 * Standalone + OnPush. Motion is CSS-first (global `login-*` keyframes) + reduced-motion-safe; the
 * `--ld-*` design tokens are inherited from the host screen (`.login` / `.forgot`).
 */
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

/**
 * A welcome slide on the brand panel. The title TYPES OUT char-by-char (blinking caret); the body
 * crossfades. Keys index the i18n bundles. With one slide the carousel does not rotate.
 */
export interface WelcomeSlide {
  readonly titleKey: string;
  readonly bodyKey: string;
}

/** Login's 3-slide welcome — the component default so the login screen needs no slide props. */
export const DEFAULT_BRAND_SLIDES: readonly WelcomeSlide[] = [
  { titleKey: 'auth.login.slides.customers.title', bodyKey: 'auth.login.slides.customers.body' },
  { titleKey: 'auth.login.slides.risk.title', bodyKey: 'auth.login.slides.risk.body' },
  { titleKey: 'auth.login.slides.realtime.title', bodyKey: 'auth.login.slides.realtime.body' },
];

/** Typewriter speed (ms per character) and how long a fully-typed title holds before advancing. */
const TYPE_INTERVAL_MS = 45;
const SLIDE_HOLD_MS = 2600;

@Component({
  selector: 'app-auth-brand-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslateModule],
  templateUrl: './auth-brand-pane.component.html',
  styleUrl: './auth-brand-pane.component.scss',
})
export class AuthBrandPaneComponent implements OnInit, OnDestroy {
  private readonly i18n = inject(TranslateService);

  /** The wordmark + tagline (same brand for both screens, hence the defaults). */
  @Input() brandKey = 'app.brand';
  @Input() taglineKey = 'app.tagline';

  /** Carousel slides — login passes its 3 (the default); forgot passes a single message. */
  @Input() slides: readonly WelcomeSlide[] = DEFAULT_BRAND_SLIDES;
  @Input() slidesLabelKey = 'auth.login.slides.label';
  @Input() slidesGoToKey = 'auth.login.slides.goTo';

  /** The embedded DEMO note — the per-screen differentiator (login vs forgot copy). */
  @Input() demoBadgeKey = 'auth.login.demoBadge';
  @Input() demoNoteKey = 'auth.login.demoNote';
  /**
   * Whether to render the DEMO badge + note. Default ON (login is a showcase surface). The
   * password-reset screen turns this OFF: its reset is a REAL backend flow, not a
   * simulation, so a "demo" label there would be dishonest.
   */
  @Input() showDemoNote = true;

  readonly activeSlide = signal(0);
  /** The portion of the active slide's title that has been "typed" so far. */
  readonly typedTitle = signal('');
  private typeTimer: ReturnType<typeof setInterval> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when there is more than one slide — gates the dots and the auto-advance. */
  get hasCarousel(): boolean {
    return this.slides.length > 1;
  }

  ngOnInit(): void {
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      // Show the first slide's full title at once; the dots still switch slides.
      this.activeSlide.set(0);
      this.typedTitle.set(this.slideTitle(0));
      return;
    }
    this.playSlide(0);
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  /** Jump to a slide from a dot; restarts the typewriter for that slide. */
  goToSlide(index: number): void {
    const next = ((index % this.slides.length) + this.slides.length) % this.slides.length;
    if (this.typeTimer === null && this.holdTimer === null) {
      // Reduced-motion / static mode: switch instantly, full title, no typing.
      this.activeSlide.set(next);
      this.typedTitle.set(this.slideTitle(next));
      return;
    }
    this.playSlide(next);
  }

  /** The body i18n key of the active slide (bound by the template, translated via the pipe). */
  activeBodyKey(): string {
    return this.slides[this.activeSlide()].bodyKey;
  }

  /** Resolve a slide's title in the current language (for the typewriter). */
  private slideTitle(index: number): string {
    return this.i18n.instant(this.slides[index].titleKey);
  }

  /**
   * Type out `index`'s title char-by-char, hold, then advance to the next slide. With a single slide
   * it types once and stops (no hold/advance) so a lone message reads as a calm static headline.
   */
  private playSlide(index: number): void {
    this.clearTimers();
    this.activeSlide.set(index);
    const full = this.slideTitle(index);
    this.typedTitle.set('');
    let typed = 0;
    this.typeTimer = setInterval(() => {
      typed += 1;
      this.typedTitle.set(full.slice(0, typed));
      if (typed >= full.length) {
        if (this.typeTimer !== null) {
          clearInterval(this.typeTimer);
          this.typeTimer = null;
        }
        if (this.hasCarousel) {
          this.holdTimer = setTimeout(() => {
            this.playSlide((index + 1) % this.slides.length);
          }, SLIDE_HOLD_MS);
        }
      }
    }, TYPE_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.typeTimer !== null) {
      clearInterval(this.typeTimer);
      this.typeTimer = null;
    }
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
