/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component unit tests for the status badge. The component is dependency-free; these pin the
 * colour→class resolution (named colour, explicit colourClass override, and `custom` opt-out) and
 * the composed class strings the template binds — the v2 rule that a badge is never colour-only
 * (icon/label/dot always present) lives in the markup, asserted here via the class composition.
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiBadgeComponent } from './ui-badge.component';

describe('UiBadgeComponent', () => {
  let component: UiBadgeComponent;
  let ref: ComponentRef<UiBadgeComponent>;

  const set = (inputs: Record<string, unknown>): UiBadgeComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiBadgeComponent] });
    const fixture = TestBed.createComponent(UiBadgeComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('maps a named colour to its modifier class', () => {
    expect(set({ color: 'green' }).badgeClassString).toContain('ui-badge--green');
    expect(set({ color: 'red' }).badgeClassString).toContain('ui-badge--red');
  });

  it('always includes the base ui-badge class', () => {
    expect(set({ color: 'blue' }).badgeClassString).toContain('ui-badge');
  });

  it('lets an explicit colorClass override the named colour', () => {
    const c = set({ color: 'green', colorClass: 'my-custom' });
    expect(c.badgeClassString).toContain('my-custom');
    expect(c.badgeClassString).not.toContain('ui-badge--green');
  });

  it('emits no colour modifier for the custom opt-out', () => {
    expect(set({ color: 'custom' }).badgeClassString).not.toMatch(/ui-badge--/);
  });

  it('treats an empty string as present text but null as absent', () => {
    expect(set({ text: '' }).hasText).toBe(true);
    expect(set({ text: 'Active' }).hasText).toBe(true);
    expect(set({ text: null }).hasText).toBe(false);
  });

  it('composes the icon class string with the bound icon', () => {
    const c = set({ icon: 'ph-check' });
    expect(c.iconClassString).toContain('ui-badge__icon');
    expect(c.iconClassString).toContain('ph-check');
  });

  it('composes the dot class string', () => {
    expect(set({ dot: true }).dotClassString).toContain('ui-badge__dot');
  });
});
