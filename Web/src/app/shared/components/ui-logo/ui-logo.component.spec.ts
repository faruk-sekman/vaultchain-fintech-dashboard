/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component smoke test. The logo is a static inlined SVG with a single toggle input
 * (`showWordmark`, cropped for the collapsed rail). Pins the default and the set value via the
 * signal input; the geometry lives in markup. RouterLink + ngx-translate are provided so the
 * template (routerLink + translate pipe) compiles under `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { UiLogoComponent } from './ui-logo.component';

describe('UiLogoComponent', () => {
  let component: UiLogoComponent;
  let ref: ComponentRef<UiLogoComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiLogoComponent, TranslateModule.forRoot()],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(UiLogoComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('shows the wordmark by default', () => {
    expect(component.showWordmark()).toBe(true);
  });

  it('can crop to the mark for a collapsed rail', () => {
    ref.setInput('showWordmark', false);
    expect(component.showWordmark()).toBe(false);
  });
});
