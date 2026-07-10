/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import {
  AuthBrandPaneComponent,
  DEFAULT_BRAND_SLIDES,
  type WelcomeSlide,
} from './auth-brand-pane.component';
import brandTemplate from './auth-brand-pane.component.html?raw';

/** Class-level setup (repo convention): the stubbed `instant` returns a fixed 3-char title. */
function setup() {
  const i18n = { currentLang: 'tr', instant: (_key: string) => 'abc' };
  TestBed.configureTestingModule({
    providers: [{ provide: TranslateService, useValue: i18n }],
  });
  const component = TestBed.runInInjectionContext(() => new AuthBrandPaneComponent());
  return { component, i18n };
}

describe('AuthBrandPaneComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to login's 3 welcome slides and exposes the carousel", () => {
    const { component } = setup();
    expect(component.slides).toBe(DEFAULT_BRAND_SLIDES);
    expect(component.slides.length).toBe(3);
    expect(component.hasCarousel).toBe(true);
    expect(component.activeSlide()).toBe(0);
  });

  it('goToSlide selects and wraps the active slide (static/no-timer mode)', () => {
    const { component } = setup();
    // No ngOnInit → no timers running → goToSlide switches instantly (the reduced-motion path).
    component.goToSlide(2);
    expect(component.activeSlide()).toBe(2);
    component.goToSlide(component.slides.length); // index === length wraps back to 0
    expect(component.activeSlide()).toBe(0);
  });

  it('types the active slide title, then advances; stops on destroy', () => {
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.ngOnInit(); // jsdom has no matchMedia → motion allowed → typewriter runs
      expect(component.activeSlide()).toBe(0);

      vi.advanceTimersByTime(3 * 45); // type the (stubbed) 3-char title "abc"
      expect(component.typedTitle()).toBe('abc');

      vi.advanceTimersByTime(2600); // hold elapses → advance to slide 1
      expect(component.activeSlide()).toBe(1);

      component.ngOnDestroy();
      const frozen = component.activeSlide();
      vi.advanceTimersByTime(10000); // timers cleared — no further advance
      expect(component.activeSlide()).toBe(frozen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with a single slide: types once and never auto-advances (no carousel, no dots)', () => {
    vi.useFakeTimers();
    try {
      const { component } = setup();
      const one: readonly WelcomeSlide[] = [
        { titleKey: 'auth.forgot.brandHeadline', bodyKey: 'auth.forgot.brandBody' },
      ];
      component.slides = one;
      expect(component.hasCarousel).toBe(false);

      component.ngOnInit();
      vi.advanceTimersByTime(3 * 45); // types "abc"
      expect(component.typedTitle()).toBe('abc');

      vi.advanceTimersByTime(10000); // a lone slide must NOT loop/re-type
      expect(component.activeSlide()).toBe(0);
      expect(component.typedTitle()).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('under reduced motion: shows the first title in full at once, no typewriter timers', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: true, media: q }) as MediaQueryList,
    );
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.ngOnInit(); // prefers-reduced-motion → static path
      expect(component.activeSlide()).toBe(0);
      expect(component.typedTitle()).toBe('abc'); // full title immediately, not typed out
      vi.advanceTimersByTime(10000); // no timers scheduled → nothing advances
      expect(component.activeSlide()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goToSlide restarts the typewriter when a slide is mid-play (running-timer branch)', () => {
    // Motion allowed (matches:false) so ngOnInit starts the typewriter rather than the static path.
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: false, media: q }) as MediaQueryList,
    );
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.ngOnInit(); // starts the typewriter (typeTimer running)
      vi.advanceTimersByTime(45); // 1 char typed, timer still running
      component.goToSlide(2); // a running timer → playSlide(2), NOT the instant static path
      expect(component.activeSlide()).toBe(2);
      vi.advanceTimersByTime(3 * 45);
      expect(component.typedTitle()).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates a late typewriter tick after the timer handle was cleared', () => {
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.ngOnInit();
      (component as unknown as { typeTimer: ReturnType<typeof setInterval> | null }).typeTimer =
        null;

      vi.advanceTimersByTime(3 * 45);

      expect(component.typedTitle()).toBe('abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('activeBodyKey returns the active slide body key', () => {
    const { component } = setup();
    expect(component.activeBodyKey()).toBe(DEFAULT_BRAND_SLIDES[0].bodyKey);
    component.goToSlide(1);
    expect(component.activeBodyKey()).toBe(DEFAULT_BRAND_SLIDES[1].bodyKey);
  });

  it('renders the decor (chart + orbs) and gates the dots behind the carousel flag', () => {
    const doc = new DOMParser().parseFromString(brandTemplate, 'text/html');
    expect(doc.querySelector('.auth-brand__chart-svg')).not.toBeNull();
    expect(doc.querySelectorAll('.auth-brand__orb').length).toBe(7);
    expect(doc.querySelector('.auth-brand__slide-title')).not.toBeNull();
    expect(doc.querySelector('.auth-brand__caret')).not.toBeNull();
    // Dots only render when there is more than one slide.
    expect(brandTemplate).toContain('@if (hasCarousel)');
    expect(brandTemplate).toContain('goToSlide(i)');
    expect(brandTemplate).toContain('typedTitle()');
  });
});
