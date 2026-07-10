/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component tests on a real `TestBed.createComponent()`. The template renders `role="switch"` +
 * `aria-checked="{{isOn()}}"` and binds `(click)="toggle()"`, so asserting `isOn`/`isDisabled` and
 * `toggle()` against a real FormControl fully covers the rendered a11y state and keyboard activation
 * (Space/Enter on a native <button> dispatch click). Signal inputs are set via `setInput`; effects
 * (control re-subscribe, disabled-sync, external value reflection) are flushed with `detectChanges()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { UiSwitchComponent } from './ui-switch.component';

describe('UiSwitchComponent', () => {
  let fixture: ComponentFixture<UiSwitchComponent>;
  let component: UiSwitchComponent;

  const setControl = (control: FormControl<boolean>): void => {
    fixture.componentRef.setInput('control', control);
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiSwitchComponent] });
    fixture = TestBed.createComponent(UiSwitchComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('has stateless defaults', () => {
    expect(component.checked()).toBe(false);
    expect(component.isOn()).toBe(false);
    expect(component.isDisabled()).toBe(false);
  });

  it('reflects the bound control value via isOn', () => {
    const control = new FormControl(false, { nonNullable: true });
    setControl(control);
    expect(component.isOn()).toBe(false);

    control.setValue(true);
    expect(component.isOn()).toBe(true);
  });

  it('seeds isOn from the control value already present at bind time', () => {
    setControl(new FormControl(true, { nonNullable: true }));
    expect(component.isOn()).toBe(true);
  });

  it('toggles the bound FormControl and marks it dirty + touched', () => {
    const control = new FormControl(false, { nonNullable: true });
    setControl(control);

    const emitted: boolean[] = [];
    component.change.subscribe(v => emitted.push(v));

    component.toggle();
    expect(control.value).toBe(true);
    expect(control.dirty).toBe(true);
    expect(control.touched).toBe(true);
    expect(component.isOn()).toBe(true);
    expect(emitted).toEqual([true]);

    component.toggle();
    expect(control.value).toBe(false);
    expect(component.isOn()).toBe(false);
    expect(emitted).toEqual([true, false]);
  });

  it('seeds stateless isOn from the checked input (one-way binding)', () => {
    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    expect(component.isOn()).toBe(true);

    fixture.componentRef.setInput('checked', false);
    fixture.detectChanges();
    expect(component.isOn()).toBe(false);
  });

  it('works in stateless mode with checked + (change) output', () => {
    const onChange = vi.fn();
    component.change.subscribe(onChange);

    component.toggle();
    expect(component.isOn()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled via the input', () => {
    const onChange = vi.fn();
    component.change.subscribe(onChange);

    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(component.isDisabled()).toBe(true);
    component.toggle();
    expect(onChange).not.toHaveBeenCalled();
    expect(component.isOn()).toBe(false);
  });

  it('reflects a disabled bound control and blocks toggle', () => {
    const control = new FormControl(false, { nonNullable: true });
    setControl(control);

    // Parent disables the control directly at runtime (no input change → no re-enable).
    control.disable();
    expect(component.isDisabled()).toBe(true);
    component.toggle();
    expect(control.value).toBe(false);
  });

  it('computes a labelId only when both label and id are present', () => {
    expect(component.labelId()).toBeNull();

    fixture.componentRef.setInput('id', 'sw-theme');
    expect(component.labelId()).toBeNull();

    fixture.componentRef.setInput('label', 'Dark mode');
    expect(component.labelId()).toBe('sw-theme-label');
  });

  it('syncs the disabled input down to the bound control', () => {
    const control = new FormControl(false, { nonNullable: true });
    fixture.componentRef.setInput('disabled', true);
    setControl(control);
    expect(control.disabled).toBe(true);

    fixture.componentRef.setInput('disabled', false);
    fixture.detectChanges();
    expect(control.enabled).toBe(true);
  });

  it('re-subscribes to a newly bound control', () => {
    const first = new FormControl(false, { nonNullable: true });
    setControl(first);

    const second = new FormControl(true, { nonNullable: true });
    setControl(second);
    expect(component.isOn()).toBe(true);

    // The old control no longer drives the view.
    first.setValue(true);
    expect(component.isOn()).toBe(true);
    second.setValue(false);
    expect(component.isOn()).toBe(false);
  });
});
