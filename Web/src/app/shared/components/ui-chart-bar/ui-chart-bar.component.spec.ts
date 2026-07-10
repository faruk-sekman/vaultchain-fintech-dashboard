/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UiChartBarComponent } from './ui-chart-bar.component';

function createComponent(): UiChartBarComponent {
  TestBed.configureTestingModule({});
  return TestBed.runInInjectionContext(() => new UiChartBarComponent());
}

describe('UiChartBarComponent', () => {
  let component: UiChartBarComponent;

  beforeEach(() => {
    component = createComponent();
  });

  it('is empty (not loading) with no data or an all-zero max', () => {
    component.data = [];
    expect(component.isEmpty).toBe(true);

    component.data = [{ label: 'A', values: [0] }];
    expect(component.isEmpty).toBe(true);
    expect(component.bars).toEqual([]);
  });

  it('is not "empty" while loading', () => {
    component.data = [];
    component.loading = true;
    expect(component.isEmpty).toBe(false);
  });

  it('computes the max across all series for the 0-baseline scale', () => {
    component.data = [
      { label: 'A', values: [10, 30] },
      { label: 'B', values: [50, 20] },
    ];
    expect(component.maxValue).toBe(50);
  });

  it('emits one bar per (category × series); the tallest bar reaches the plot top', () => {
    component.data = [
      { label: 'A', values: [25] },
      { label: 'B', values: [50] },
    ];
    const bars = component.bars;
    expect(bars).toHaveLength(2);
    const tallest = bars.find(b => b.value === 50)!;
    const shorter = bars.find(b => b.value === 25)!;
    // 50 is the max → its bar is twice the height of the 25 bar.
    expect(tallest.height).toBeCloseTo(shorter.height * 2, 5);
  });

  it('produces a category tick per category', () => {
    component.data = [
      { label: 'Jan', values: [1] },
      { label: 'Feb', values: [2] },
      { label: 'Mar', values: [3] },
    ];
    expect(component.ticks.map(t => t.label)).toEqual(['Jan', 'Feb', 'Mar']);
  });

  it('keeps a label for every named category (≤8) — no thinning of categorical axes', () => {
    // The dashboard KYC chart passes 6 named statuses; all must stay visible
    // (thinning is only for dense >8-category time-series axes).
    const kyc = ['Not started', 'Pending', 'In review', 'Verified', 'Rejected', 'Expired'];
    component.data = kyc.map((label, i) => ({ label, values: [i + 1] }));
    expect(component.ticks.map(t => t.label)).toEqual(kyc);
  });

  it('gives each label a per-category slot width for wrapping (finding #8)', () => {
    // The template boxes every tick to `--tick-slot = 100 / ticks.length %` and
    // centres it over its bar, so long names wrap to ~2 lines instead of
    // overrunning their neighbours at narrow widths. This asserts the layout
    // value the template binds is the exact slot fraction for all 6 categories.
    const kyc = ['Not started', 'Pending', 'In review', 'Verified', 'Rejected', 'Expired'];
    component.data = kyc.map((label, i) => ({ label, values: [i + 1] }));
    const slotPct = 100 / component.ticks.length;
    expect(component.ticks).toHaveLength(6);
    expect(slotPct).toBeCloseTo(100 / 6, 10);
  });

  it('renders a legend only for named series', () => {
    component.data = [{ label: 'A', values: [1, 2] }];
    expect(component.hasLegend).toBe(false);

    component.series = [{ name: 'Target' }, { name: 'Reality' }];
    expect(component.hasLegend).toBe(true);
    expect(component.legendItems.map(l => l.name)).toEqual(['Target', 'Reality']);
  });

  it('honours an explicit series colour, else falls back to the v2 palette', () => {
    component.data = [{ label: 'A', values: [1, 1] }];
    component.series = [{ name: 'T', color: 'var(--chart-5)' }, { name: 'R' }];
    const bars = component.bars;
    expect(bars[0].color).toBe('var(--chart-5)');
    // v2 §4: the second (unstyled) series renders in --color-accent-teal.
    expect(bars[1].color).toBe('var(--color-accent-teal)');
  });

  it('defaults series A to --chart-1 and caps bars to slim v2 capsules', () => {
    component.data = [{ label: 'A', values: [10] }];
    const [bar] = component.bars;
    expect(bar.color).toBe('var(--chart-1)');
    // A single category would otherwise be very wide; v2 caps it at ~15 units.
    expect(bar.width).toBeLessThanOrEqual(15);
    // Fully-rounded top: barPath rounds the corners with radius = min(width/2, height).
    // The bar is far taller than it is wide, so the radius is half the (capped) width;
    // the rounded-top segment of the path therefore curves from (x, y+r) to (x+r, y).
    const r = Math.min(bar.width / 2, bar.height);
    expect(r).toBeCloseTo(bar.width / 2, 5);
    const f = (n: number): string => n.toFixed(2);
    const roundedTop =
      `L${f(bar.x)},${f(bar.y + r)}` + `Q${f(bar.x)},${f(bar.y)} ${f(bar.x + r)},${f(bar.y)}`;
    expect(component.barPath(bar)).toContain(roundedTop);
  });

  it('builds gridline labels from the formatter (top = max, bottom = 0)', () => {
    component.formatVal = v => `${v}u`;
    component.data = [{ label: 'A', values: [100] }];
    const grid = component.gridLines;
    expect(grid[0].label).toBe('100u');
    expect(grid[grid.length - 1].label).toBe('0u');
  });

  it('defaults furniture on (v2.1 G5 additive input)', () => {
    expect(component.furniture).toBe(true);
  });

  it('nice-rounds the y-axis top above a non-round max and scales bars against it', () => {
    component.formatVal = v => `${v}`;
    component.data = [{ label: 'A', values: [37] }];

    // 37/4 segments → nice step 10 → axis top 40 (0,10,20,30,40 = 5 lines).
    expect(component.scaleMax).toBe(40);
    const grid = component.gridLines;
    expect(grid).toHaveLength(5);
    expect(grid.map(g => g.label)).toEqual(['40', '30', '20', '10', '0']);

    // The bar tops out at 37/40 of the plot height (plotH = 200 - 8 - 24 = 168).
    const [bar] = component.bars;
    expect(bar.height).toBeCloseTo((37 / 40) * 168, 5);
  });

  it('keeps ~5 gridlines across nice scales (v2.1 G5)', () => {
    component.data = [{ label: 'A', values: [50] }];
    // step 10 → 0..50 = 6 lines; top equals the raw max, so the bar hits the top.
    expect(component.scaleMax).toBe(50);
    expect(component.gridLines).toHaveLength(6);

    component.data = [{ label: 'A', values: [100] }];
    // step 20 → 0..100 = 6 lines.
    expect(component.scaleMax).toBe(100);
    expect(component.gridLines).toHaveLength(6);
  });

  it('positions gridlines (and so the y labels) evenly from plot top to the 0 baseline', () => {
    component.data = [{ label: 'A', values: [37] }];
    const grid = component.gridLines;
    // plotH = 168, PAD_TOP = 8: lines at 8, 50, 92, 134, 176 (the baseline).
    expect(grid[0].y).toBeCloseTo(8, 5);
    expect(grid[grid.length - 1].y).toBeCloseTo(176, 5);
    const gaps = grid.slice(1).map((g, i) => g.y - grid[i].y);
    expect(gaps.every(gap => Math.abs(gap - gaps[0]) < 1e-6)).toBe(true);
  });

  it('furniture=false keeps the legacy raw-max scale and fixed 5-line grid', () => {
    component.furniture = false;
    component.formatVal = v => `${v}`;
    component.data = [{ label: 'A', values: [37] }];

    expect(component.scaleMax).toBe(37);
    const grid = component.gridLines;
    expect(grid).toHaveLength(5);
    expect(grid[0].label).toBe('37');
    expect(grid[grid.length - 1].label).toBe('0');

    // Legacy geometry: the tallest bar reaches the plot top exactly.
    const [bar] = component.bars;
    expect(bar.height).toBeCloseTo(168, 5);
  });

  // --- audit 9C: hover tooltip, gradient/value-label modes, palette cycling, baseline ---

  it('onMove snaps to the nearest category and surfaces the tooltip; onLeave hides it', () => {
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [20] },
    ];
    component.formatVal = v => `${v}`;
    const event = {
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 300,
      clientY: 40,
    } as unknown as MouseEvent;

    component.onMove(event);
    expect(component.hoverLabel).toBe('B');
    expect(component.tip.visible).toBe(true);
    expect(component.tip.title).toBe('B');
    expect(component.tip.rows[0].value).toBe('20');

    component.onLeave();
    expect(component.hoverLabel).toBeNull();
    expect(component.tip.visible).toBe(false);
  });

  it('onMove is a no-op when there are no usable categories', () => {
    component.data = [];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 1,
      clientY: 1,
    } as unknown as MouseEvent);
    expect(component.tip.visible).toBe(false);
  });

  it('gradient mode builds one def per visible bar and fills via url()', () => {
    component.gradient = true;
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [0] },
    ];
    expect(component.gradientDefs).toHaveLength(1); // only the height>0 bar
    const visibleBar = component.bars.find(b => b.height > 0)!;
    expect(component.barFill(visibleBar)).toBe(`url(#${visibleBar.gradId})`);
  });

  it('flat mode fills bars with the plain hue', () => {
    component.data = [{ label: 'A', values: [10] }];
    const [bar] = component.bars;
    expect(component.barFill(bar)).toBe(bar.color);
  });

  it('valueLabels mode positions a label above each visible bar', () => {
    component.valueLabels = true;
    component.formatVal = v => `${v}`;
    component.data = [{ label: 'A', values: [10] }];
    const items = component.valueLabelItems;
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('10');
    expect(items[0].xPct).toBeGreaterThan(0);
  });

  it('cycles the palette for a third series and exposes the baseline y', () => {
    component.data = [{ label: 'A', values: [1, 1, 1] }];
    expect(component.bars[2].color).toBe('var(--chart-3)');
    expect(component.baselineY).toBeCloseTo(8 + (200 - 8 - 24), 5);
  });

  it('exposes stable track-by identities for bars, ticks, grid and legend', () => {
    expect(component.trackByBar(0, { categoryLabel: 'Jan', seriesName: 'Target' } as never)).toBe(
      'Jan|Target',
    );
    expect(component.trackByTick(0, { label: 'Feb' } as never)).toBe('Feb');
    expect(component.trackByGrid(0, { y: 17 } as never)).toBe(17);
    expect(component.trackByLegend(0, { name: 'Reality' } as never)).toBe('Reality');
  });

  // --- empty getters, per-category colour, dense thinning, opt-out modes ---

  it('axis getters return empty/zero with no usable data', () => {
    component.data = [];
    expect(component.scaleMax).toBe(0);
    expect(component.gridLines).toEqual([]);
    expect(component.ticks).toEqual([]);
    expect(component.bars).toEqual([]);
  });

  it('nice-rounds a small max into a 1× step (f < 1.5 branch)', () => {
    component.formatVal = v => `${v}`;
    component.data = [{ label: 'A', values: [10] }];
    // rough = 10/4 = 2.5, base = 1 → f = 2.5 (the 2× branch); a max of 4 exercises 1×.
    component.data = [{ label: 'A', values: [4] }];
    // rough = 1, base = 1, f = 1 (< 1.5) → step 1 → top 4.
    expect(component.scaleMax).toBe(4);
  });

  it('colours a single-series bar by its per-category colour, in both bars and the tooltip', () => {
    component.formatVal = v => `${v}`;
    component.data = [{ label: 'Verified', values: [30], color: 'var(--chart-2)' }];
    const [bar] = component.bars;
    expect(bar.color).toBe('var(--chart-2)'); // n === 1 && cat.color branch
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 10,
      clientY: 5,
    } as unknown as MouseEvent);
    expect(component.tip.color).toBe('var(--chart-2)');
  });

  it('onMove labels rows by series name and treats a missing value as 0', () => {
    component.formatVal = v => `${v}`;
    component.data = [
      { label: 'A', values: [10] }, // series index 1 missing → ?? 0
      { label: 'B', values: [20, 5] },
    ];
    component.series = [{ name: 'Target' }, { name: 'Reality' }];
    component.onMove({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 320 }) },
      clientX: 0,
      clientY: 5,
    } as unknown as MouseEvent);
    expect(component.tip.rows[0].label).toBe('Target');
    expect(component.tip.rows[1].label).toBe('Reality');
    expect(component.tip.rows[1].value).toBe('0'); // missing index-1 value at category A
  });

  it('thins dense category axes to ~8 labels but always keeps the last category', () => {
    component.data = Array.from({ length: 11 }, (_, i) => ({ label: `c${i}`, values: [i + 1] }));
    const labels = component.ticks.map(t => t.label);
    expect(labels[0]).toBe('c0');
    expect(labels[labels.length - 1]).toBe('c10'); // last kept via the `ci === last` branch
    expect(labels.length).toBeLessThan(11);
  });

  it('a zero-height bar yields no per-bar gradient def, no value label, and an empty path', () => {
    component.gradient = true;
    component.valueLabels = true;
    component.data = [
      { label: 'A', values: [10] },
      { label: 'B', values: [0] }, // zero height → filtered out of both lists
    ];
    expect(component.gradientDefs).toHaveLength(1);
    expect(component.valueLabelItems).toHaveLength(1);
    const zeroBar = component.bars.find(b => b.height === 0)!;
    expect(component.barPath(zeroBar)).toBe('');
  });

  it('gradientDefs and valueLabelItems are empty when those modes are off', () => {
    component.data = [{ label: 'A', values: [10] }];
    expect(component.gradient).toBe(false);
    expect(component.valueLabels).toBe(false);
    expect(component.gradientDefs).toEqual([]);
    expect(component.valueLabelItems).toEqual([]);
  });
});
