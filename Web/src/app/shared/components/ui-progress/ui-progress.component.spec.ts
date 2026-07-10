/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiProgressComponent } from '@shared/components/ui-progress/ui-progress.component';

describe('UiProgressComponent', () => {
  let component: UiProgressComponent;
  let ref: ComponentRef<UiProgressComponent>;

  const set = (inputs: Record<string, unknown>): UiProgressComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiProgressComponent] });
    const fixture = TestBed.createComponent(UiProgressComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has determinate defaults', () => {
    expect(component.value()).toBe(0);
    expect(component.indeterminate()).toBe(false);
    expect(component.color()).toBe('primary');
    expect(component.showValue()).toBe(false);
  });

  it('clamps and rounds the value to the 0–100 range', () => {
    expect(set({ value: 42 }).clampedValue).toBe(42);
    expect(set({ value: 150 }).clampedValue).toBe(100);
    expect(set({ value: -10 }).clampedValue).toBe(0);
    expect(set({ value: 33.6 }).clampedValue).toBe(34);
    expect(set({ value: Number.NaN }).clampedValue).toBe(0);
  });

  it('exposes a fill width style in determinate mode', () => {
    expect(set({ value: 70 }).fillStyle).toEqual({ width: '70%' });
  });

  it('drops the fill width in indeterminate mode', () => {
    expect(set({ indeterminate: true, value: 70 }).fillStyle).toEqual({});
  });

  it('carries colour, label and accessibility inputs', () => {
    const progress = set({
      color: 'success',
      label: 'Upload',
      showValue: true,
      ariaLabel: 'File upload progress',
      id: 'kyc-progress',
      class: 'mt-2',
    });
    expect(progress.color()).toBe('success');
    expect(progress.label()).toBe('Upload');
    expect(progress.showValue()).toBe(true);
    expect(progress.ariaLabel()).toBe('File upload progress');
    expect(progress.id()).toBe('kyc-progress');
    expect(progress.class()).toBe('mt-2');
  });
});
