/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for UiChartTipComponent (audit 9C Web). Exercises the cursor-relative positioning getter:
 * the default offset, the right/bottom edge flips, and the transformed-containing-block branch. Signal
 * inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`; the fixture
 * host element is attached under a parent so `containingBlock()` can walk real ancestors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UiChartTipComponent } from './ui-chart-tip.component';

describe('UiChartTipComponent', () => {
  let parent: HTMLElement;
  let fixture: ComponentFixture<UiChartTipComponent>;
  let component: UiChartTipComponent;

  const set = (inputs: Record<string, unknown>): UiChartTipComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiChartTipComponent] });
    fixture = TestBed.createComponent(UiChartTipComponent);
    component = fixture.componentInstance;
    parent = document.createElement('div');
    parent.appendChild(fixture.nativeElement);
    document.body.appendChild(parent);
  });

  afterEach(() => {
    parent.remove();
  });

  it('positions just off the cursor when there is no transformed ancestor', () => {
    const style = set({ x: 100, y: 120 }).style;
    expect(style['left']).toBe('100px');
    expect(style['top']).toBe('120px');
    expect(style['transform']).toBe('translate(14px, 18px)');
  });

  it('flips the card near the right and bottom edges', () => {
    expect(set({ x: 99999, y: 99999 }).style['transform']).toBe(
      'translate(calc(-100% - 14px), calc(-100% - 14px))',
    );
  });

  it('subtracts the offset of a transformed containing block', () => {
    parent.style.transform = 'translateX(5px)';
    // jsdom getBoundingClientRect is 0,0 so the value is unchanged, but the transformed branch runs.
    const style = set({ x: 50, y: 60 }).style;
    expect(style['left']).toBe('50px');
    expect(style['top']).toBe('60px');
  });

  it('recognises a containing block established by a filter (not just transform)', () => {
    // First OR operand (transform) is falsy → the filter operand must be evaluated.
    parent.style.filter = 'blur(1px)';
    const style = set({ x: 70, y: 80 }).style;
    expect(style['left']).toBe('70px');
    expect(style['top']).toBe('80px');
  });

  it('recognises a containing block established by perspective', () => {
    parent.style.perspective = '200px';
    const style = set({ x: 30, y: 40 }).style;
    expect(style['left']).toBe('30px');
    expect(style['top']).toBe('40px');
  });

  it('walks past plain ancestors with no establishing style and uses the viewport origin', () => {
    // No ancestor sets transform/filter/perspective → containingBlock returns {0,0}
    // and the card sits at the raw cursor coordinates.
    const style = set({ x: 12, y: 34 }).style;
    expect(style['left']).toBe('12px');
    expect(style['top']).toBe('34px');
  });

  it('uses SSR viewport fallbacks when window is unavailable', () => {
    const originalWindow = globalThis.window;
    vi.stubGlobal('window', undefined);
    try {
      const style = set({ x: 50, y: 60 }).style;
      expect(style['left']).toBe('50px');
      expect(style['top']).toBe('60px');
      expect(style['transform']).toBe('translate(14px, 18px)');
    } finally {
      vi.stubGlobal('window', originalWindow);
    }
  });
});
