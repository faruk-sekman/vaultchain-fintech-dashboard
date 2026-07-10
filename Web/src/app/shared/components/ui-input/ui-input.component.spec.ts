/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Direct (no-DOM) unit tests. The input's real logic is the digit mask (`#` = digit slot, other
 * chars literal) and the disabled↔control sync; both are pinned here. The mask writes back with
 * emitEvent:false so it never loops, and is skipped for type=number.
 */
import { describe, it, expect } from 'vitest';
import { FormControl } from '@angular/forms';
import { SimpleChange } from '@angular/core';
import { UiInputComponent } from './ui-input.component';

const onChange = (
  c: UiInputComponent,
  control: FormControl,
  extra: Record<string, SimpleChange> = {},
) => c.ngOnChanges({ control: new SimpleChange(null, control, true), ...extra });

describe('UiInputComponent mask', () => {
  it('formats digits into the mask pattern, ignoring non-digits', () => {
    const c = new UiInputComponent();
    c.mask = '(###) ###-####';
    expect((c as unknown as { applyMask(v: string): string }).applyMask('555abc1234567')).toBe(
      '(555) 123-4567',
    );
  });

  it('returns an empty string when there are no digits', () => {
    const c = new UiInputComponent();
    c.mask = '###';
    expect((c as unknown as { applyMask(v: string): string }).applyMask('abc')).toBe('');
  });

  it('applies the mask to the control value on bind (without emitting)', () => {
    const c = new UiInputComponent();
    const control = new FormControl('5551234567');
    c.control = control;
    c.mask = '(###) ###-####';
    onChange(c, control, { mask: new SimpleChange(null, c.mask, true) });
    expect(control.value).toBe('(555) 123-4567');
  });

  it('keeps masking subsequent value changes', () => {
    const c = new UiInputComponent();
    const control = new FormControl('');
    c.control = control;
    c.mask = '## ##';
    onChange(c, control, { mask: new SimpleChange(null, c.mask, true) });

    control.setValue('1234');
    expect(control.value).toBe('12 34');
  });

  it('does not mask a number input', () => {
    const c = new UiInputComponent();
    const control = new FormControl('1234');
    c.control = control;
    c.type = 'number';
    c.mask = '## ##';
    onChange(c, control, { mask: new SimpleChange(null, c.mask, true) });
    expect(control.value).toBe('1234');
  });
});

describe('UiInputComponent disabled sync', () => {
  it('disables the bound control when the disabled input is set', () => {
    const c = new UiInputComponent();
    const control = new FormControl('x');
    c.control = control;
    c.disabled = true;
    onChange(c, control, { disabled: new SimpleChange(false, true, false) });
    expect(control.disabled).toBe(true);
  });

  it('re-enables the control when disabled is cleared', () => {
    const c = new UiInputComponent();
    const control = new FormControl({ value: 'x', disabled: true });
    c.control = control;
    c.disabled = false;
    onChange(c, control, { disabled: new SimpleChange(true, false, false) });
    expect(control.enabled).toBe(true);
  });

  it('unsubscribes cleanly on destroy', () => {
    const c = new UiInputComponent();
    const control = new FormControl('');
    c.control = control;
    c.mask = '###';
    onChange(c, control, { mask: new SimpleChange(null, '###', true) });
    expect(() => c.ngOnDestroy()).not.toThrow();
  });
});

describe('UiInputComponent stripPattern (A2/B7)', () => {
  it('strips disallowed characters as the user types (phone: digits and + only)', () => {
    const c = new UiInputComponent();
    const control = new FormControl('');
    c.control = control;
    c.stripPattern = '[^0-9+]';
    onChange(c, control, { stripPattern: new SimpleChange(null, c.stripPattern, true) });

    control.setValue('+90 (555) abc-123');
    expect(control.value).toBe('+90555123');
  });

  it('strips the bound value too, without emitting', () => {
    const c = new UiInputComponent();
    const control = new FormControl('abc123def');
    c.control = control;
    c.stripPattern = '[^0-9]';
    onChange(c, control, { stripPattern: new SimpleChange(null, c.stripPattern, true) });
    expect(control.value).toBe('123');
  });

  it('composes with the digit mask (strip first, then mask)', () => {
    const c = new UiInputComponent();
    const control = new FormControl('');
    c.control = control;
    c.stripPattern = '[^0-9]';
    c.mask = '## ##';
    onChange(c, control, {
      mask: new SimpleChange(null, c.mask, true),
      stripPattern: new SimpleChange(null, c.stripPattern, true),
    });
    control.setValue('1a2b3c4d');
    expect(control.value).toBe('12 34');
  });
});
