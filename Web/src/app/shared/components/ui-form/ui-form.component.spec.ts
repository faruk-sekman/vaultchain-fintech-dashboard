/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * A raw `placeholder` on a FieldConfig is an additive, per-instance hint. The critical
 * contract these specs lock is that setting `placeholder` (a) carries through to the fields the
 * template binds and (b) does NOT change the control signature — so adding the masked-placeholder on
 * the customer edit form never rebuilds the FormGroup or drops the operator's in-progress values
 * (blank-means-keep is preserved). The `??` precedence over `placeholderKey` lives in the template;
 * this jsdom/vitest build does not resolve `templateUrl`, so it is verified via the consumer
 * (customer-form) + the input binding, not by rendering this component.
 */

import { describe, it, expect } from 'vitest';
import { SimpleChange } from '@angular/core';
import { Validators } from '@angular/forms';
import { UiFormComponent } from './ui-form.component';
import { FieldConfig } from './ui-form.types';

class TranslateMock {
  currentLang = 'en';
  instant(key: string) {
    return key;
  }
}

function makeForm(fields: FieldConfig[]): UiFormComponent {
  const form = new UiFormComponent(
    new TranslateMock() as never,
    { markForCheck: () => {} } as never,
  );
  form.fields = fields;
  form.ngOnChanges({ fields: new SimpleChange(null, fields, true) });
  return form;
}

describe('UiFormComponent — raw placeholder', () => {
  it('carries a raw placeholder through to the effective fields the template binds', () => {
    const fields: FieldConfig[] = [
      { name: 'name', labelKey: 'lbl.name', type: 'text', placeholder: 'J*** D***' },
      { name: 'email', labelKey: 'lbl.email', type: 'email', placeholderKey: 'ph.email' },
    ];
    const form = makeForm(fields);

    const effective = form.effectiveFields;
    expect(effective.find(f => f.name === 'name')?.placeholder).toBe('J*** D***');
    // A field with only placeholderKey keeps it (the template resolves it via translate).
    expect(effective.find(f => f.name === 'email')?.placeholderKey).toBe('ph.email');
    expect(effective.find(f => f.name === 'email')?.placeholder).toBeUndefined();
  });

  it('does NOT rebuild the FormGroup (or drop values) when only the placeholder changes', () => {
    const initial: FieldConfig[] = [
      { name: 'name', labelKey: 'lbl.name', type: 'text' },
      { name: 'email', labelKey: 'lbl.email', type: 'email' },
    ];
    const form = makeForm(initial);
    const groupBefore = form.form;
    form.control('name').setValue('operator typed this');

    // Re-emit the SAME field names but now carrying masked placeholders (the applyMaskedPlaceholders
    // path) — names unchanged, so the control signature is stable and the form is reused.
    const withPlaceholders: FieldConfig[] = [
      { name: 'name', labelKey: 'lbl.name', type: 'text', placeholder: 'J*** D***' },
      { name: 'email', labelKey: 'lbl.email', type: 'email', placeholder: 'a***@e***.com' },
    ];
    form.fields = withPlaceholders;
    form.ngOnChanges({ fields: new SimpleChange(initial, withPlaceholders, false) });

    expect(form.form).toBe(groupBefore);
    // The in-progress value survived (blank-means-keep / no data loss).
    expect(form.control('name').value).toBe('operator typed this');
    expect(form.effectiveFields.find(f => f.name === 'name')?.placeholder).toBe('J*** D***');
  });
});

describe('UiFormComponent — field-error association', () => {
  it('errorId derives a stable id from the field id', () => {
    const form = makeForm([{ name: 'email', labelKey: 'lbl.email', type: 'email' }]);
    // The error element id is the input id with an `-error` suffix; the input references it.
    expect(form.errorId('email', 0)).toBe(`${form.fieldId('email', 0)}-error`);
  });

  it('describedBy is null while valid/pristine and the error id once an error is shown', () => {
    const fields: FieldConfig[] = [
      { name: 'email', labelKey: 'lbl.email', type: 'email', validators: [Validators.required] },
    ];
    const form = makeForm(fields);

    // Pristine + untouched → no error shown → nothing to describe.
    expect(form.describedBy('email', 0)).toBeNull();

    // Make it invalid AND dirty so `fieldState` reports 'invalid' and the error renders.
    const control = form.control('email');
    control.setValue('');
    control.markAsDirty();

    expect(form.hasDisplayError('email')).toBe(true);
    expect(form.describedBy('email', 0)).toBe(form.errorId('email', 0));
  });

  it('describedBy stays null for a dirty but valid field (no dangling reference)', () => {
    const fields: FieldConfig[] = [
      { name: 'email', labelKey: 'lbl.email', type: 'email', validators: [Validators.required] },
    ];
    const form = makeForm(fields);
    const control = form.control('email');
    control.setValue('a@b.com');
    control.markAsDirty();

    expect(form.hasDisplayError('email')).toBe(false);
    expect(form.describedBy('email', 0)).toBeNull();
  });

  it('A2/B5: a TOUCHED (blurred) invalid field shows its error even while pristine', () => {
    const fields: FieldConfig[] = [
      { name: 'amount', labelKey: 'lbl.amount', type: 'number', validators: [Validators.required] },
    ];
    const form = makeForm(fields);
    const control = form.control('amount');

    // Untouched + pristine → silent (unchanged baseline behavior).
    expect(form.fieldState('amount')).toBeNull();

    // Blur without typing (touched, still pristine) → the required error becomes VISIBLE. The old
    // dirty-only gate hid it, which was the B5 "silent no-op" on the empty Amount field.
    control.markAsTouched();
    expect(form.fieldState('amount')).toBe('invalid');
    expect(form.hasDisplayError('amount')).toBe(true);
    expect(form.getError('amount')).toEqual({ key: 'validation.required' });
  });

  it('A2: markAllAsTouched via submit() makes every invalid field visibly erroneous', () => {
    const fields: FieldConfig[] = [
      { name: 'a', labelKey: 'lbl.a', type: 'text', validators: [Validators.required] },
      { name: 'b', labelKey: 'lbl.b', type: 'text', validators: [Validators.required] },
    ];
    const form = makeForm(fields);
    form.submit(); // double-guard path: marks touched, blocks the emit

    expect(form.hasDisplayError('a')).toBe(true);
    expect(form.hasDisplayError('b')).toBe(true);
  });

  it('B7: digitsMin/digitsMax map to digit-worded keys with params', () => {
    const fields: FieldConfig[] = [{ name: 'phone', labelKey: 'lbl.phone', type: 'text' }];
    const form = makeForm(fields);
    const control = form.control('phone');

    control.setErrors({ digitsMin: { min: 7, actual: 3 } });
    expect(form.getError('phone')).toEqual({ key: 'validation.digitsMin', params: { min: 7 } });

    control.setErrors({ digitsMax: { max: 15, actual: 16 } });
    expect(form.getError('phone')).toEqual({ key: 'validation.digitsMax', params: { max: 15 } });
  });
});
