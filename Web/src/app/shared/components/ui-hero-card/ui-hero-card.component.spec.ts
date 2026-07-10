/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { UiHeroCardComponent } from './ui-hero-card.component';

/** Class-level tests (matching the committed ui-stat-card spec pattern). */
describe('UiHeroCardComponent', () => {
  it('has spec defaults (gradient variant, no value/meta/footnote)', () => {
    const c = new UiHeroCardComponent();
    expect(c.variant).toBe('gradient');
    expect(c.valueLabel).toBe('');
    expect(c.value).toBeNull();
    expect(c.meta).toEqual([]);
    expect(c.footnote).toBeNull();
    expect(c.id).toBeNull();
  });

  it('reports the empty state only when the value is missing', () => {
    const c = new UiHeroCardComponent();
    expect(c.isEmpty).toBe(true); // null value

    c.value = '';
    expect(c.isEmpty).toBe(true);

    c.value = 0;
    expect(c.isEmpty).toBe(false);

    c.value = '1,248';
    expect(c.isEmpty).toBe(false);
  });

  it('renders at most two meta pairs (§4: two small label/value pairs in a row)', () => {
    const c = new UiHeroCardComponent();
    expect(c.metaPairs).toEqual([]);

    c.meta = [
      { label: 'Aktif', value: '1,102' },
      { label: 'Pasif', value: '146' },
      { label: 'Fazla', value: 'asla' },
    ];
    expect(c.metaPairs).toHaveLength(2);
    expect(c.metaPairs.map(p => p.label)).toEqual(['Aktif', 'Pasif']);
  });

  it('accepts the outline variant (surface + border, navy text — token-driven)', () => {
    const c = new UiHeroCardComponent();
    c.variant = 'outline';
    expect(c.variant).toBe('outline');
  });

  it('keeps consumer-provided pre-translated/pre-masked strings verbatim (no keys inside)', () => {
    const c = new UiHeroCardComponent();
    c.valueLabel = 'Toplam Bakiye';
    c.value = '$12,750';
    c.footnote = '5234 **** **** 1289';
    expect(c.valueLabel).toBe('Toplam Bakiye');
    expect(c.value).toBe('$12,750');
    expect(c.footnote).toBe('5234 **** **** 1289');
  });

  it('computes the optional progress ring (clamp + dashoffset + label)', () => {
    const c = new UiHeroCardComponent();
    expect(c.ringPct).toBeNull(); // no ring by default

    c.ring = 150;
    expect(c.ringPct).toBe(100); // clamped high
    c.ring = -10;
    expect(c.ringPct).toBe(0); // clamped low

    c.ring = 42;
    expect(c.ringPct).toBe(42);
    expect(c.ringLabel).toBe('42%');
    expect(c.ringDashoffset).toBeCloseTo(c.ringCircumference * (1 - 0.42));
  });

  it('treats a non-finite ring as absent (null pct, 0% label, full offset)', () => {
    const c = new UiHeroCardComponent();
    c.ring = Number.NaN;
    expect(c.ringPct).toBeNull();
    expect(c.ringLabel).toBe('0%');
    expect(c.ringDashoffset).toBe(c.ringCircumference);
  });
});
