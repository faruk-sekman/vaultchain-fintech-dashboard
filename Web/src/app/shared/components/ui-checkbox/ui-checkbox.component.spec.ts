/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Component smoke tests. The checkbox is presentational (template-only — it binds a required
 * FormControl), so there is no behaviour to pin beyond its defaults and that it accepts a bound
 * control. Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`;
 * the required `control` is provided before the first assertion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl } from '@angular/forms';
import { UiCheckboxComponent } from './ui-checkbox.component';

describe('UiCheckboxComponent', () => {
  let component: UiCheckboxComponent;
  let ref: ComponentRef<UiCheckboxComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiCheckboxComponent] });
    const fixture = TestBed.createComponent(UiCheckboxComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
    // `control` is a required input — provide one before reads.
    ref.setInput('control', new FormControl(false));
  });

  it('has presentational defaults', () => {
    expect(component.readOnly()).toBe(false);
    expect(component.disabled()).toBe(false);
    expect(component.label()).toBeNull();
    expect(component.id()).toBeNull();
  });

  it('accepts a bound FormControl', () => {
    ref.setInput('control', new FormControl(true));
    expect(component.control().value).toBe(true);
  });
});
