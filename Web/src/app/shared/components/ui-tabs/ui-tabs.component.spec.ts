/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Renders the real underline tabs via `TestBed.createComponent()` and exercises selection + keyboard
 * navigation. The fixture host is attached to the document so `focusTab`/`getElementById` resolve
 * against the real rendered tabs. Signal inputs are set through `ComponentRef.setInput()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { UiTabsComponent, UiTabItem } from './ui-tabs.component';

const ITEMS: UiTabItem[] = [
  { value: 'overview', label: 'Overview', icon: 'ri-dashboard-line' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'kyc', label: 'KYC', disabled: true },
  { value: 'risk', label: 'Risk' },
];

describe('UiTabsComponent', () => {
  let fixture: ComponentFixture<UiTabsComponent>;
  let component: UiTabsComponent;

  const setValue = (value: string | null): void => {
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
  };

  const buttonFor = (value: string): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector(`#${component.tabId(value)}`);

  function keydown(value: string, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, cancelable: true });
    const item = ITEMS.find(t => t.value === value)!;
    component.onKeydown(event, item);
    return event;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiTabsComponent, TranslateModule.forRoot()],
    });
    fixture = TestBed.createComponent(UiTabsComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('items', ITEMS);
    fixture.componentRef.setInput('value', 'overview');
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.nativeElement.remove();
  });

  it('builds stable, unique tab ids', () => {
    expect(component.tabId('overview')).toMatch(/^ui-tab-\d+-overview$/);
    expect(component.tabId('overview')).not.toBe(component.tabId('risk'));
  });

  it('derives a panel id paired 1:1 with the tab id (aria-controls ↔ panel.id)', () => {
    expect(component.panelId('overview')).toBe(`${component.tabId('overview')}-panel`);
    expect(component.panelId('overview')).toMatch(/^ui-tab-\d+-overview-panel$/);
    expect(component.panelId('overview')).not.toBe(component.panelId('risk'));
  });

  it('reports the selected tab', () => {
    expect(component.isSelected(ITEMS[0])).toBe(true);
    expect(component.isSelected(ITEMS[1])).toBe(false);
  });

  it('applies roving tabindex: only the active tab is tabbable', () => {
    expect(component.tabIndexFor(ITEMS[0])).toBe(0);
    expect(component.tabIndexFor(ITEMS[1])).toBe(-1);
  });

  it('keeps a disabled tab out of the tab order', () => {
    expect(component.tabIndexFor(ITEMS[2])).toBe(-1);
  });

  it('falls back to the first enabled tab for roving focus when value is null', () => {
    setValue(null);
    expect(component.tabIndexFor(ITEMS[0])).toBe(0);
    expect(component.tabIndexFor(ITEMS[1])).toBe(-1);
  });

  it('emits valueChange on select', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    component.select(ITEMS[1]);
    expect(emit).toHaveBeenCalledWith('transactions');
  });

  it('does not emit when selecting the active or a disabled tab', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    component.select(ITEMS[0]); // active
    component.select(ITEMS[2]); // disabled
    expect(emit).not.toHaveBeenCalled();
  });

  it('ArrowRight moves selection to the next enabled tab and moves focus', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    const event = keydown('overview', 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith('transactions');
    expect(document.activeElement).toBe(buttonFor('transactions'));
  });

  it('ArrowRight skips a disabled tab', () => {
    setValue('transactions');
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    // transactions → (kyc disabled, skipped) → risk
    keydown('transactions', 'ArrowRight');
    expect(emit).toHaveBeenCalledWith('risk');
    expect(document.activeElement).toBe(buttonFor('risk'));
  });

  it('ArrowLeft wraps from the first enabled tab to the last', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    keydown('overview', 'ArrowLeft');
    expect(emit).toHaveBeenCalledWith('risk');
  });

  it('ArrowDown/ArrowUp behave like horizontal arrows', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    keydown('overview', 'ArrowDown');
    expect(emit).toHaveBeenLastCalledWith('transactions');
    setValue('transactions');
    keydown('transactions', 'ArrowUp');
    expect(emit).toHaveBeenLastCalledWith('overview');
  });

  it('Home and End jump to the first and last enabled tabs', () => {
    setValue('transactions');
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    keydown('transactions', 'End');
    expect(emit).toHaveBeenLastCalledWith('risk');
    setValue('risk');
    keydown('risk', 'Home');
    expect(emit).toHaveBeenLastCalledWith('overview');
  });

  it('Enter and Space (re)select the focused tab and prevent default', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    const enter = keydown('transactions', 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenCalledWith('transactions');

    setValue('transactions');
    const space = keydown('risk', ' ');
    expect(space.defaultPrevented).toBe(true);
    expect(emit).toHaveBeenLastCalledWith('risk');
  });

  it('ignores unrelated keys', () => {
    const emit = vi.fn();
    component.valueChange.subscribe(emit);
    const event = keydown('overview', 'a');
    expect(event.defaultPrevented).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('keeps keyboard navigation inert when every tab is disabled', () => {
    const disabled = ITEMS.map(item => ({ ...item, disabled: true }));
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

  it('trackByValue returns the item value', () => {
    expect(component.trackByValue(0, ITEMS[0])).toBe('overview');
  });
});
