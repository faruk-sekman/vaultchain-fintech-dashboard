/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component unit tests for the loading skeleton. The only logic is the `styles` getter that
 * maps the bound dimensions to CSS custom properties (omitting unset ones); the rest is presentational.
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiSkeletonComponent } from './ui-skeleton.component';

describe('UiSkeletonComponent', () => {
  let component: UiSkeletonComponent;
  let ref: ComponentRef<UiSkeletonComponent>;

  const set = (inputs: Record<string, unknown>): UiSkeletonComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiSkeletonComponent] });
    const fixture = TestBed.createComponent(UiSkeletonComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has sensible defaults', () => {
    expect(component.variant()).toBe('line');
    expect(component.animate()).toBe(true);
  });

  it('maps the set dimensions to CSS custom properties', () => {
    expect(set({ width: '10rem', height: '2rem', radius: '4px' }).styles).toEqual({
      '--skeleton-w': '10rem',
      '--skeleton-h': '2rem',
      '--skeleton-r': '4px',
    });
  });

  it('omits unset dimensions from the style map', () => {
    expect(set({ width: '50%' }).styles).toEqual({ '--skeleton-w': '50%' });
    expect(set({ width: null }).styles).toEqual({});
  });
});
