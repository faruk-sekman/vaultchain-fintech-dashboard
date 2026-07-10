/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiStatAccent, UiStatCardComponent, UiStatTone } from './ui-stat-card.component';

describe('UiStatCardComponent', () => {
  let component: UiStatCardComponent;
  let ref: ComponentRef<UiStatCardComponent>;

  const set = (inputs: Record<string, unknown>): UiStatCardComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiStatCardComponent] });
    const fixture = TestBed.createComponent(UiStatCardComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has spec defaults', () => {
    expect(component.accent()).toBe('indigo');
    expect(component.loading()).toBe(false);
    expect(component.delta()).toBeNull();
    expect(component.trend()).toBeNull();
    expect(component.sparkWidth).toBe(64);
    expect(component.sparkHeight).toBe(28);
  });

  it('reports the empty state only when not loading and value is missing', () => {
    expect(component.isEmpty).toBe(true); // null value
    expect(set({ value: '' }).isEmpty).toBe(true);
    expect(set({ value: '0' }).isEmpty).toBe(false);
    expect(set({ value: null, loading: true }).isEmpty).toBe(false); // loading is never "empty"
  });

  it('maps each accent to the correct badge + chart tokens', () => {
    const cases: Array<[UiStatAccent, string, string]> = [
      ['indigo', 'var(--badge-indigo-bg)', 'var(--chart-1)'],
      ['blue', 'var(--badge-blue-bg)', 'var(--chart-2)'],
      ['teal', 'var(--badge-teal-bg)', 'var(--chart-3)'],
      ['green', 'var(--badge-green-bg)', 'var(--chart-4)'],
      ['amber', 'var(--badge-yellow-bg)', 'var(--chart-5)'],
      ['red', 'var(--badge-red-bg)', 'var(--chart-6)'],
      ['violet', 'var(--badge-purple-bg)', 'var(--chart-7)'],
    ];
    for (const [accent, bg, chart] of cases) {
      const c = set({ accent });
      expect(c.chipBg).toBe(bg);
      expect(c.accentColor).toBe(chart);
    }
    const amber = set({ accent: 'amber' });
    expect(amber.chipText).toBe('var(--badge-yellow-text)');
    expect(amber.accentStyles).toEqual({
      '--stat-chip-bg': 'var(--badge-yellow-bg)',
      '--stat-chip-text': 'var(--badge-yellow-text)',
      '--stat-accent': 'var(--chart-5)',
    });
  });

  it('builds the accessible delta sentence and honors an explicit override', () => {
    expect(component.deltaAccessibleText).toBe(''); // no delta
    expect(set({ delta: { value: 8, direction: 'up' } }).deltaAccessibleText).toBe('increased 8');
    expect(set({ delta: { value: 3, direction: 'down' } }).deltaAccessibleText).toBe('decreased 3');
    expect(set({ deltaLabel: 'decreased by 3 percent' }).deltaAccessibleText).toBe(
      'decreased by 3 percent',
    );
  });

  it('requires at least two points to render a sparkline', () => {
    expect(component.hasTrend).toBe(false);
    expect(set({ trend: [3] }).hasTrend).toBe(false);
    expect(set({ trend: [3, 5] }).hasTrend).toBe(true);
  });

  it('normalises sparkline geometry into the padded viewBox', () => {
    const c = set({ trend: [0, 5, 10] });
    const points = c.sparkPoints.split(' ').map(p => p.split(',').map(Number));
    expect(points).toHaveLength(3);

    // x spans the padded width: first at pad (2), last at width-pad (62).
    expect(points[0][0]).toBeCloseTo(2, 1);
    expect(points[2][0]).toBeCloseTo(62, 1);

    // Min value sits at the bottom (height-pad = 26), max at the top (pad = 2).
    expect(points[0][1]).toBeCloseTo(26, 1);
    expect(points[2][1]).toBeCloseTo(2, 1);

    const last = c.sparkLastPoint;
    expect(last?.x).toBeCloseTo(62, 1);
    expect(last?.y).toBeCloseTo(2, 1);

    // Area path closes back to the baseline.
    expect(c.sparkAreaPath.startsWith('M ')).toBe(true);
    expect(c.sparkAreaPath.endsWith('Z')).toBe(true);
  });

  it('handles a flat trend (zero span) without dividing by zero', () => {
    const ys = set({ trend: [4, 4, 4] })
      .sparkPoints.split(' ')
      .map(p => Number(p.split(',')[1]));
    // All equal => every y collapses to the bottom of the band (height - pad).
    expect(ys.every(y => Math.abs(y - 26) < 0.01)).toBe(true);
  });

  it('returns no sparkline geometry when there is no usable trend', () => {
    expect(component.sparkPoints).toBe('');
    expect(component.sparkAreaPath).toBe('');
    expect(component.sparkLastPoint).toBeNull();
  });

  it('resolves the link accessible name, preferring ariaLabel', () => {
    expect(set({ label: 'Total customers' }).linkAccessibleName).toBe('Total customers');
    expect(set({ ariaLabel: 'Open customers list' }).linkAccessibleName).toBe(
      'Open customers list',
    );
  });

  it('defaults layout to "default" so the stacked card is unchanged (additive v2.1 G2 input)', () => {
    expect(component.layout()).toBe('default');

    // The pill form is opt-in and orthogonal to tone/accent/value behaviour.
    const c = set({ layout: 'pill', value: '1,248' });
    expect(c.isEmpty).toBe(false);
    expect(c.layout()).toBe('pill');
  });

  it('defaults tone to null so the legacy accent chip is unchanged (additive input)', () => {
    expect(component.tone()).toBeNull();
    expect(component.accentStyles).toEqual({
      '--stat-chip-bg': 'var(--badge-indigo-bg)',
      '--stat-chip-text': 'var(--badge-indigo-text)',
      '--stat-accent': 'var(--chart-1)',
    });
  });

  it('maps each v2 tone to its --tile-* background and accent glyph tokens', () => {
    const cases: Array<[UiStatTone, string, string]> = [
      ['blue', 'var(--tile-blue)', 'var(--color-link)'],
      ['yellow', 'var(--tile-yellow)', 'var(--color-accent-yellow)'],
      ['teal', 'var(--tile-teal)', 'var(--color-accent-teal)'],
      ['pink', 'var(--tile-pink)', 'var(--color-danger)'],
    ];
    for (const [tone, bg, icon] of cases) {
      const c = set({ tone });
      expect(c.chipBg).toBe(bg);
      expect(c.chipText).toBe(icon);
    }
    // The sparkline accent still follows `accent`, not `tone`.
    expect(set({ accent: 'teal' }).accentColor).toBe('var(--chart-3)');
  });

  it('renders the delta as a signed "+x%" (v2 §1.4: sign is mandatory, magnitude absolute)', () => {
    expect(component.deltaDisplay).toBe(''); // no delta
    expect(set({ delta: { value: 8, direction: 'up' } }).deltaDisplay).toBe('+8%');
    expect(set({ delta: { value: 3, direction: 'down' } }).deltaDisplay).toBe('-3%');
    // Defensive: a consumer passing a pre-signed magnitude never double-signs.
    expect(set({ delta: { value: -3, direction: 'down' } }).deltaDisplay).toBe('-3%');
  });
});
