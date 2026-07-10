/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UiChartDonutComponent } from './ui-chart-donut.component';

function createComponent(): UiChartDonutComponent {
  TestBed.configureTestingModule({});
  return TestBed.runInInjectionContext(() => new UiChartDonutComponent());
}

describe('UiChartDonutComponent', () => {
  let component: UiChartDonutComponent;

  beforeEach(() => {
    component = createComponent();
  });

  it('is empty (not loading) when there is no positive data', () => {
    component.data = [];
    expect(component.isEmpty).toBe(true);
    expect(component.slices).toEqual([]);
    expect(component.total).toBe(0);
  });

  it('is not "empty" while loading even with no data', () => {
    component.data = [];
    component.loading = true;
    expect(component.isEmpty).toBe(false);
  });

  it('ignores zero/negative/non-finite values', () => {
    component.data = [
      { label: 'A', value: 10 },
      { label: 'Z', value: 0 },
      { label: 'N', value: -5 },
      { label: 'X', value: Number.NaN },
    ];
    expect(component.total).toBe(10);
    expect(component.slices.map(s => s.label)).toEqual(['A']);
  });

  it('computes fractions and percentages that sum to the whole', () => {
    component.data = [
      { label: 'Verified', value: 60 },
      { label: 'Pending', value: 40 },
    ];
    const slices = component.slices;
    expect(component.total).toBe(100);
    expect(slices[0].percent).toBe(60);
    expect(slices[1].percent).toBe(40);
    expect(slices[0].fraction + slices[1].fraction).toBeCloseTo(1, 5);
  });

  it('assigns the v2 palette order (5,3,4,1,…) but honours an explicit slice colour', () => {
    component.data = [
      { label: 'A', value: 1 },
      { label: 'B', value: 1, color: 'var(--chart-8)' },
      { label: 'C', value: 1 },
      { label: 'D', value: 1 },
    ];
    const slices = component.slices;
    // v2 §4: defaults walk --chart-5 → --chart-3 → --chart-4 → --chart-1 …
    expect(slices[0].color).toBe('var(--chart-5)');
    expect(slices[1].color).toBe('var(--chart-8)'); // explicit wins
    expect(slices[2].color).toBe('var(--chart-4)');
    expect(slices[3].color).toBe('var(--chart-1)');
  });

  it('builds inline % labels on the ring centreline, skipping slivers', () => {
    component.data = [
      { label: 'Big', value: 92 },
      { label: 'Sliver', value: 8 }, // 8% — right at the legibility floor
    ];
    const [big, sliver] = component.slices;
    expect(big.percentLabel).toBe('92%');
    expect(big.showLabel).toBe(true);
    expect(sliver.showLabel).toBe(true);

    component.data = [
      { label: 'Big', value: 95 },
      { label: 'Tiny', value: 5 },
    ];
    expect(component.slices[1].showLabel).toBe(false);

    // Label anchors sit on the ring (distance from centre ≈ radius).
    const d = Math.hypot(big.labelX - component.center, big.labelY - component.center);
    expect(d).toBeCloseTo(component.radius, 1);

    // Default 200px render keeps the label at 16px on screen (viewBox 100 → 8 units).
    expect(component.percentFontSize).toBe(8);
  });

  it('falls back to the viewBox height for percent labels when height is non-positive', () => {
    component.height = 0;
    expect(component.percentFontSize).toBe(16);

    component.height = -20;
    expect(component.percentFontSize).toBe(16);
  });

  it('offsets each segment after the previous one (cumulative dashoffset)', () => {
    component.data = [
      { label: 'A', value: 50 },
      { label: 'B', value: 50 },
    ];
    const slices = component.slices;
    // First slice starts at the ring origin (0, allowing for -0); the second is
    // pushed back by the first slice's fraction.
    expect(Math.abs(slices[0].dashOffset)).toBe(0);
    expect(slices[1].dashOffset).toBeLessThan(0);
  });

  it('formats the centre total with the provided formatter', () => {
    component.formatVal = v => `$${v}`;
    component.data = [{ label: 'A', value: 7 }];
    expect(component.formattedTotal).toBe('$7');
  });

  it('formats values with the default localized integer formatter', () => {
    component.data = [{ label: 'A', value: 1234 }];
    expect(component.formattedTotal).toBe((1234).toLocaleString());
  });

  // --- hover tooltip + single-segment geometry + track-by ---

  it('onSliceMove surfaces the slice value + share at the cursor, then onLeave hides it', () => {
    component.formatVal = v => `${v}`;
    component.data = [
      { label: 'Verified', value: 75 },
      { label: 'Pending', value: 25 },
    ];
    const slice = component.slices[0];
    component.onSliceMove({ clientX: 120, clientY: 40 } as MouseEvent, slice);
    expect(component.hoverLabel).toBe('Verified');
    expect(component.tip.visible).toBe(true);
    expect(component.tip.x).toBe(120);
    expect(component.tip.y).toBe(40);
    expect(component.tip.title).toBe('Verified');
    expect(component.tip.rows[0].value).toBe('75');
    expect(component.tip.rows[1].value).toBe(`${slice.percent}%`);

    component.onLeave();
    expect(component.hoverLabel).toBeNull();
    expect(component.tip.visible).toBe(false);
  });

  it('a single full-circle slice keeps its full arc length (no inter-segment gap)', () => {
    component.data = [{ label: 'Only', value: 40 }];
    const [only] = component.slices;
    // With one slice the gap-trim branch falls back to the full arc, so the
    // visible length is the whole circumference (dashOffset stays at the origin).
    expect(only.fraction).toBe(1);
    expect(only.percent).toBe(100);
    expect(Math.abs(only.dashOffset)).toBe(0);
    const [visible] = only.dashArray.split(' ').map(Number);
    expect(visible).toBeGreaterThan(260); // ~2π·42 ≈ 263.9, untrimmed
  });

  it('trackByLabel returns the slice label as a stable identity', () => {
    const slice = { label: 'KYC', value: 1, color: '', fraction: 1 } as never;
    expect(component.trackByLabel(0, slice)).toBe('KYC');
  });
});
