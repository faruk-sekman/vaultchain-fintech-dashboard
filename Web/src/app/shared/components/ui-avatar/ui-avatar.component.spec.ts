/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component tests. Signal inputs are set through `ComponentRef.setInput()` on a real
 * `TestBed.createComponent()`; `imageFailed` stays plain mutable component state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiAvatarComponent } from './ui-avatar.component';

describe('UiAvatarComponent', () => {
  let component: UiAvatarComponent;
  let ref: ComponentRef<UiAvatarComponent>;

  const set = (inputs: Record<string, unknown>): UiAvatarComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiAvatarComponent] });
    const fixture = TestBed.createComponent(UiAvatarComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has spec defaults', () => {
    expect(component.size()).toBe('md');
    expect(component.shape()).toBe('squircle');
    expect(component.color()).toBe('brand');
    expect(component.status()).toBeNull();
    expect(component.imageFailed).toBe(false);
  });

  it('derives up to two uppercase initials from the name', () => {
    expect(set({ name: 'Ada Lovelace' }).initials).toBe('AL');
    expect(set({ name: 'grace' }).initials).toBe('G');
    expect(set({ name: '  Margaret  Heafield  Hamilton ' }).initials).toBe('MH');
    expect(set({ name: '  ' }).initials).toBe('');
    expect(set({ name: null }).initials).toBe('');
  });

  it('uses a visible fallback glyph when a name has no letter characters', () => {
    expect(set({ name: '  123  ' }).initials).toBe('1');
    expect(set({ name: '' }).accessibleName).toBe('');
  });

  it('shows an image when src is set and falls back on error', () => {
    const c = set({ name: 'Ada', src: 'https://example.test/a.png' });
    expect(c.showImage).toBe(true);
    expect(c.showInitials).toBe(false);

    c.onImageError();
    expect(c.imageFailed).toBe(true);
    expect(c.showImage).toBe(false);
    // With the image gone, the initials fallback takes over.
    expect(c.showInitials).toBe(true);
  });

  it('follows the image -> initials -> icon -> default precedence', () => {
    // Initials win over an icon when a name exists.
    const c = set({ name: 'Ada Lovelace', icon: 'ri-bank-line' });
    expect(c.showInitials).toBe(true);
    expect(c.showIcon).toBe(false);

    // No name + icon => icon fallback.
    set({ name: null });
    expect(c.showInitials).toBe(false);
    expect(c.showIcon).toBe(true);

    // No name + no icon => neither flag set (template renders the default user icon).
    set({ icon: null });
    expect(c.showIcon).toBe(false);
    expect(c.showInitials).toBe(false);
    expect(c.showImage).toBe(false);
  });

  it('produces a deterministic, stable categorical hue for auto color', () => {
    const a = set({ name: 'Ada Lovelace', color: 'auto' });
    const idx = a.hueIndex;
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThanOrEqual(8);
    expect(a.hueIndex).toBe(idx); // stable across calls
    expect(a.fallbackStyles['--avatar-fallback']).toBe(`var(--chart-${idx})`);

    // Same name on a different instance => same hue (deterministic).
    const fixtureB = TestBed.createComponent(UiAvatarComponent);
    fixtureB.componentRef.setInput('name', 'Ada Lovelace');
    fixtureB.componentRef.setInput('color', 'auto');
    expect(fixtureB.componentInstance.hueIndex).toBe(idx);

    expect(set({ name: null }).hueIndex).toBeGreaterThanOrEqual(1);
  });

  it('emits no fallback styles for the brand color or when there are no initials', () => {
    expect(set({ name: 'Ada', color: 'brand' }).fallbackStyles).toEqual({});
    expect(set({ color: 'auto', name: null }).fallbackStyles).toEqual({});
  });

  it('resolves the accessible name, preferring an explicit ariaLabel', () => {
    expect(set({ name: 'Ada Lovelace' }).accessibleName).toBe('Ada Lovelace');
    expect(set({ ariaLabel: 'Customer avatar' }).accessibleName).toBe('Customer avatar');
    expect(set({ name: null, ariaLabel: null }).accessibleName).toBeNull();
  });

  it('exposes status text with an override fallback', () => {
    expect(component.statusText).toBe('');
    expect(set({ status: 'online' }).statusText).toBe('online');
    expect(set({ statusLabel: 'Online' }).statusText).toBe('Online');
  });
});
