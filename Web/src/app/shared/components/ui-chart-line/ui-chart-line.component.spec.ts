/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UiChartLineComponent } from './ui-chart-line.component';

function createComponent(): UiChartLineComponent {
  TestBed.configureTestingModule({});
  return TestBed.runInInjectionContext(() => new UiChartLineComponent());
}

describe('UiChartLineComponent', () => {
  let component: UiChartLineComponent;

  beforeEach(() => {
    component = createComponent();
  });

  it('is empty (not loading) with fewer than two points', () => {
    component.data = [{ label: 'only', values: [5] }];
    expect(component.isEmpty).toBe(true);
    expect(component.paths).toEqual([]);
  });

  it('is empty when every value is zero', () => {
    component.data = [
      { label: 'A', values: [0] },
      { label: 'B', values: [0] },
    ];
    expect(component.isEmpty).toBe(true);
  });

  it('is not "empty" while loading', () => {
    component.data = [];
    component.loading = true;
    expect(component.isEmpty).toBe(false);
  });

  it('builds a smooth line path beginning with a moveto and using cubic segments', () => {
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [20] },
      { label: 'C', values: [15] },
    ];
    const path = component.paths[0];
    expect(path.linePath.startsWith('M ')).toBe(true);
    expect(path.linePath).toContain(' C ');
  });

  it('fills a lone series by default and closes the area path', () => {
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [20] },
    ];
    const path = component.paths[0];
    expect(path.areaPath).not.toBeNull();
    expect(path.areaPath!.trimEnd().endsWith('Z')).toBe(true);
  });

  it('fills only the series flagged area:true when series are named', () => {
    component.data = [
      { label: 'A', values: [10, 4] },
      { label: 'B', values: [20, 8] },
    ];
    component.series = [{ name: 'Revenue', area: true }, { name: 'Refunds' }];
    const paths = component.paths;
    expect(paths[0].areaPath).not.toBeNull();
    expect(paths[1].areaPath).toBeNull();
  });

  it('gives each series a unique gradient id', () => {
    component.data = [
      { label: 'A', values: [1, 2] },
      { label: 'B', values: [3, 4] },
    ];
    component.series = [
      { name: 'X', area: true },
      { name: 'Y', area: true },
    ];
    const [a, b] = component.paths;
    expect(a.gradientId).not.toBe(b.gradientId);
  });

  it('computes the max across all series for the 0-baseline', () => {
    component.data = [
      { label: 'A', values: [10, 30] },
      { label: 'B', values: [50, 20] },
    ];
    expect(component.maxValue).toBe(50);
  });

  it('emits one x tick per point and builds grid labels from the formatter', () => {
    component.formatVal = v => `${v}k`;
    component.data = [
      { label: 'Jan', values: [40] },
      { label: 'Feb', values: [80] },
    ];
    expect(component.ticks.map(t => t.label)).toEqual(['Jan', 'Feb']);
    const grid = component.gridLines;
    expect(grid[0].label).toBe('80k');
    expect(grid[grid.length - 1].label).toBe('0k');
  });

  it('renders a legend only for named series', () => {
    component.data = [
      { label: 'A', values: [1] },
      { label: 'B', values: [2] },
    ];
    expect(component.hasLegend).toBe(false);
    component.series = [{ name: 'Revenue', area: true }];
    expect(component.hasLegend).toBe(true);
  });

  // --- audit 9C: hover tooltip + hero point, area-hue derivation, dense-axis thinning ---

  it('onMove snaps to the nearest point, exposes the hover point, and onLeave clears it', () => {
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [20] },
      { label: 'C', values: [30] },
    ];
    component.formatVal = v => `${v}`;
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 320,
      clientY: 10,
    } as unknown as MouseEvent);
    expect(component.hoverIndex).toBe(2);
    expect(component.tip.visible).toBe(true);
    expect(component.tip.title).toBe('C');
    expect(component.hoverPoint).not.toBeNull();

    component.onLeave();
    expect(component.hoverIndex).toBeNull();
    expect(component.tip.visible).toBe(false);
    expect(component.hoverPoint).toBeNull();
  });

  it('onMove is a no-op when there are no points', () => {
    component.data = [];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 1,
      clientY: 1,
    } as unknown as MouseEvent);
    expect(component.tip.visible).toBe(false);
  });

  it('onMove is a no-op when the plot has no measurable width', () => {
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [20] },
    ];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 0 }) },
      clientX: 1,
      clientY: 1,
    } as unknown as MouseEvent);

    expect(component.tip.visible).toBe(false);
    expect(component.hoverIndex).toBeNull();
  });

  it('derives the area hue: hero → --chart-6, explicit wins, extra → palette', () => {
    component.data = [
      { label: 'A', values: [1, 2, 3] },
      { label: 'B', values: [4, 5, 6] },
    ];
    component.series = [
      { name: 'Hero', area: true },
      { name: 'Mid', area: true, color: 'tomato' },
      { name: 'Tail', area: true },
    ];
    const paths = component.paths;
    expect(paths[0].areaColor).toBe('var(--chart-6)');
    expect(paths[1].areaColor).toBe('tomato');
    expect(paths[2].areaColor).toBe('var(--chart-3)');
  });

  it('thins x labels beyond eight points but keeps the first and last', () => {
    component.data = Array.from({ length: 12 }, (_, i) => ({ label: `d${i}`, values: [i + 1] }));
    const labels = component.ticks.map(t => t.label);
    expect(labels[0]).toBe('d0');
    expect(labels[labels.length - 1]).toBe('d11');
    expect(labels.length).toBeLessThan(12);
  });

  it('formats axis values with the default localized integer formatter', () => {
    component.data = [
      { label: 'A', values: [1000] },
      { label: 'B', values: [2000] },
    ];
    expect(component.gridLines[0].label).toBe((2000).toLocaleString());
  });

  it('legendItems fall back to the palette hue when a series has no explicit colour', () => {
    component.series = [{ name: 'Hero' }, { name: 'Mid', color: 'tomato' }];
    const items = component.legendItems;
    expect(items[0].color).toBe('var(--chart-1)'); // palette fallback
    expect(items[1].color).toBe('tomato'); // explicit wins
  });

  it('exposes stable track-by identities for paths, grid, ticks and legend', () => {
    expect(component.trackByPath(0, { name: 'Revenue' } as never)).toBe('Revenue');
    expect(component.trackByGrid(0, { y: 42 } as never)).toBe(42);
    expect(component.trackByTick(0, { label: 'Jan' } as never)).toBe('Jan');
    expect(component.trackByLegend(0, { name: 'Refunds' } as never)).toBe('Refunds');
  });

  // --- empty/degenerate axis + multi-series gap branches ---

  it('gridLines and paths are empty when the max value is zero', () => {
    component.data = [
      { label: 'A', values: [0] },
      { label: 'B', values: [0] },
    ];
    expect(component.maxValue).toBe(0);
    expect(component.gridLines).toEqual([]);
    expect(component.paths).toEqual([]);
  });

  it('ticks are empty when there are no usable points', () => {
    component.data = [{ label: 'X', values: [] }];
    expect(component.ticks).toEqual([]);
  });

  it('a single usable point yields one tick at the left pad (no step division)', () => {
    // Two points keep the chart non-empty for paths, but only one carries values so
    // the tick step uses the single-point (zero-step) branch.
    component.data = [
      { label: 'lone', values: [5] },
      { label: 'blank', values: [] },
    ];
    const ticks = component.ticks;
    expect(ticks).toHaveLength(1);
    expect(ticks[0].label).toBe('lone');
  });

  it('builds the degenerate private path cases used by sparse data safely', () => {
    const smoothPath = (
      component as unknown as {
        smoothPath(points: ReadonlyArray<{ x: number; y: number }>): string;
      }
    ).smoothPath.bind(component);

    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 4, y: 158 }])).toBe('M 4,158');
  });

  it('treats a missing or non-positive series value as the 0 baseline', () => {
    component.data = [
      { label: 'A', values: [10] }, // series index 1 missing here → ?? 0
      { label: 'B', values: [20, 0] }, // series index 1 present but 0 → baseline
    ];
    component.series = [{ name: 'Main', area: true }, { name: 'Aux' }];
    const aux = component.paths[1];
    // The Aux line never rises above the baseline (all points at value 0).
    expect(aux.areaPath).toBeNull();
    expect(aux.linePath.startsWith('M ')).toBe(true);
  });

  it('onMove with named series labels the tooltip rows by series name', () => {
    component.formatVal = v => `${v}`;
    component.data = [
      { label: 'A', values: [10] }, // index 1 missing → ?? 0 in the tooltip
      { label: 'B', values: [20, 7] },
    ];
    component.series = [{ name: 'Revenue', area: true }, { name: 'Refunds' }];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 0,
      clientY: 5,
    } as unknown as MouseEvent);
    expect(component.tip.rows[0].label).toBe('Revenue');
    expect(component.tip.rows[1].label).toBe('Refunds');
    expect(component.tip.rows[1].value).toBe('0'); // missing index-1 value at point A
  });

  it('the hover point sits on the baseline for a zero-valued hero point', () => {
    component.data = [
      { label: 'A', values: [0] },
      { label: 'B', values: [50] },
    ];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 0,
      clientY: 5,
    } as unknown as MouseEvent);
    const point = component.hoverPoint!;
    expect(point).not.toBeNull();
    // value 0 → y stays on the baseline (PAD_TOP + plotH = 8 + 150 = 158).
    expect(point.y).toBeCloseTo(158, 5);
    expect(point.x).toBeCloseTo(4, 5); // first point → PAD_X
  });
});
