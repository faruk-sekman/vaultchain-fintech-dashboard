/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiCardComponent } from './ui-card.component';

describe('UiCardComponent', () => {
  let component: UiCardComponent;
  let ref: ComponentRef<UiCardComponent>;

  const set = (inputs: Record<string, unknown>): UiCardComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiCardComponent] });
    const fixture = TestBed.createComponent(UiCardComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has spec defaults', () => {
    expect(component.variant()).toBe('default');
    expect(component.padding()).toBe('md');
    expect(component.interactive()).toBe(false);
    expect(component.hasActions()).toBe(false);
    expect(component.hasFooter()).toBe(false);
    expect(component.headingLevel()).toBe(3);
  });

  it('renders the header when a title is present', () => {
    expect(set({ title: 'Revenue' }).hasHeader).toBe(true);
  });

  it('renders the header when only a subtitle is present', () => {
    expect(set({ title: null, subtitle: 'Last 30 days' }).hasHeader).toBe(true);
  });

  it('renders the header for an actions-only card (no title/subtitle)', () => {
    expect(set({ title: null, subtitle: null, hasActions: true }).hasHeader).toBe(true);
  });

  it('omits the header when title, subtitle and actions are all absent', () => {
    expect(set({ title: null, subtitle: null, hasActions: false }).hasHeader).toBe(false);
  });

  it('accepts the supported variants, paddings and heading levels', () => {
    for (const v of ['default', 'muted', 'gradient'] as const) {
      expect(set({ variant: v }).variant()).toBe(v);
    }
    for (const p of ['sm', 'md', 'lg'] as const) {
      expect(set({ padding: p }).padding()).toBe(p);
    }
    for (const h of [2, 3, 4] as const) {
      expect(set({ headingLevel: h }).headingLevel()).toBe(h);
    }
  });
});
