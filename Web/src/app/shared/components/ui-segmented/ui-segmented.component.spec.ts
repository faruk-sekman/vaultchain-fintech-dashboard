/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Renders the real segmented control via `TestBed.createComponent()` and drives keyboard/selection
 * behaviour. The fixture host is attached to the document so `focusSegment`/`getElementById` resolve
 * against the real rendered radios. Signal inputs are set through `ComponentRef.setInput()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { UiSegmentedComponent, UiSegmentItem } from './ui-segmented.component';

const RANGES: UiSegmentItem[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month', disabled: true },
  { value: 'year', label: 'Year' },
];

describe('UiSegmentedComponent', () => {
  let fixture: ComponentFixture<UiSegmentedComponent>;
  let component: UiSegmentedComponent;

  const setValue = (value: string | null): void => {
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
  };

  const buttonFor = (value: string): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector(`#${component.segmentId(value)}`);

  function keydown(value: string, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    const item = RANGES.find(s => s.value === value)!;
    component.onKeydown(event, item);
    return event;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiSegmentedComponent, TranslateModule.forRoot()],
    });
    fixture = TestBed.createComponent(UiSegmentedComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('items', RANGES);
    fixture.componentRef.setInput('value', 'week');
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.nativeElement.remove();
  });

  it('builds stable, unique segment ids', () => {
    expect(component.segmentId('day')).toMatch(/^ui-segment-\d+-day$/);
    expect(component.segmentId('day')).not.toBe(component.segmentId('year'));
  });

  it('reports the selected segment', () => {
    expect(component.isSelected(RANGES[1])).toBe(true);
    expect(component.isSelected(RANGES[0])).toBe(false);
  });

  it('applies roving tabindex and keeps a disabled segment out of the tab order', () => {
    expect(component.tabIndexFor(RANGES[1])).toBe(0);
    expect(component.tabIndexFor(RANGES[0])).toBe(-1);
    expect(component.tabIndexFor(RANGES[2])).toBe(-1);
  });

  it('falls back to the first enabled segment for roving focus when value is null', () => {
    setValue(null);
    expect(component.tabIndexFor(RANGES[0])).toBe(0);
    expect(component.tabIndexFor(RANGES[1])).toBe(-1);
  });

  it('emits valueChange on select, but not for the active or a disabled segment', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    component.select(RANGES[0]);
    expect(emit).toHaveBeenCalledWith('day');
    emit.mockClear();
    component.select(RANGES[1]); // active "week"
    component.select(RANGES[2]); // disabled "month"
    expect(emit).not.toHaveBeenCalled();
  });

  it('ArrowRight selects next enabled (skipping disabled) and moves focus', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    // week → (month disabled) → year
    const event = keydown('week', 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith('year');
    expect(document.activeElement).toBe(buttonFor('year'));
  });

  it('ArrowLeft wraps and ArrowUp/Down map to horizontal movement', () => {
    const emit = vi.fn();
    setValue('day');
    component.valueChange.subscribe(emit);
    keydown('day', 'ArrowLeft'); // wrap to year
    expect(emit).toHaveBeenLastCalledWith('year');
    setValue('day');
    keydown('day', 'ArrowDown'); // like ArrowRight → week
    expect(emit).toHaveBeenLastCalledWith('week');
  });

  it('Home/End jump to first/last enabled segment', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    keydown('week', 'Home');
    expect(emit).toHaveBeenLastCalledWith('day');
    keydown('day', 'End');
    expect(emit).toHaveBeenLastCalledWith('year');
  });

  it('Enter/Space select the focused segment and prevent page scroll', () => {
    const emit = vi.fn();
    setValue('week');
    component.valueChange.subscribe(emit);
    const space = keydown('day', ' ');
    expect(space.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith('day');
    const enter = keydown('year', 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenLastCalledWith('year');
  });

  it('ignores unrelated keys', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    const event = keydown('week', 'x');
    expect(event.defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps keyboard navigation inert when every segment is disabled', () => {
    const disabled = RANGES.map(item => ({ ...item, disabled: true }));
    fixture.componentRef.setInput('items', disabled);
    fixture.componentRef.setInput('value', null);
    fixture.detectChanges();
    const emit = vi.fn();
    component.valueChange.subscribe(emit);

    expect(component.tabIndexFor(disabled[0])).toBe(-1);
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    component.onKeydown(event, disabled[0]);

    expect(event.defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('computes an accessible name only for icon-only segments', () => {
    expect(component.accessibleName({ value: 'a', label: 'Day' })).toBeNull();
    expect(component.accessibleName({ value: 'a', labelKey: 'range.day' })).toBeNull();
    expect(
      component.accessibleName({ value: 'light', icon: 'ri-sun-line', ariaLabel: 'Light theme' }),
    ).toBe('Light theme');
    expect(component.accessibleName({ value: 'x', icon: 'ri-sun-line' })).toBeNull();
  });

  it('trackByValue returns the item value', () => {
    expect(component.trackByValue(0, RANGES[0])).toBe('day');
  });
});
