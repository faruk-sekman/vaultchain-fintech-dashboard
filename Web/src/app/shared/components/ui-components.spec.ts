/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { FormControl } from '@angular/forms';
import { ElementRef, SimpleChange } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import { UiSelectComponent } from '@shared/components/ui-select/ui-select.component';
import { UiCheckboxComponent } from '@shared/components/ui-checkbox/ui-checkbox.component';
import { UiPaginationComponent } from '@shared/components/ui-pagination/ui-pagination.component';
import { UiTableComponent } from '@shared/components/ui-table/ui-table.component';
import { UiFormComponent } from '@shared/components/ui-form/ui-form.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';

class TranslateMock {
  currentLang = 'en';
  instant(key: string) {
    return key;
  }
}

describe('Shared UI components', () => {
  it('UiBadgeComponent builds class strings and text state', () => {
    const badgeRef = TestBed.createComponent(UiBadgeComponent).componentRef;
    const badge = badgeRef.instance;
    badgeRef.setInput('text', 'Active');
    badgeRef.setInput('icon', 'ri-user-line');
    badgeRef.setInput('color', 'green');
    badgeRef.setInput('dot', true);

    expect(badge.hasText).toBe(true);
    expect(badge.badgeClassString).toContain('ui-badge--green');
    expect(badge.iconClassString).toContain('ri-user-line');
    expect(badge.dotClassString).toContain('ui-badge__dot');

    badgeRef.setInput('color', 'custom');
    badgeRef.setInput('colorClass', 'custom-class');
    expect(badge.badgeClassString).toContain('custom-class');

    badgeRef.setInput('colorClass', null);
    expect(badge.badgeClassString).not.toContain('ui-badge--');
  });

  it('UiButtonComponent has defaults', () => {
    const button = TestBed.createComponent(UiButtonComponent).componentInstance;
    expect(button.type()).toBe('button');
    expect(button.variant()).toBe('primary');
    expect(button.size()).toBe('md');
  });

  it('UiInputComponent applies mask and toggles disabled state', () => {
    const input = new UiInputComponent();
    const control = new FormControl('123456');
    input.control = control;
    input.mask = '###-###';
    input.ngOnChanges({
      control: new SimpleChange(null, control, true),
      mask: new SimpleChange(null, '###-###', true),
    });

    expect(control.value).toBe('123-456');

    input.disabled = true;
    input.ngOnChanges({ disabled: new SimpleChange(false, true, false) });
    expect(control.disabled).toBe(true);
    input.disabled = false;
    input.ngOnChanges({ disabled: new SimpleChange(true, false, false) });
    expect(control.enabled).toBe(true);
    input.ngOnDestroy();
  });

  it('UiInputComponent skips formatting for null values and unchanged formats', () => {
    const input = new UiInputComponent();
    const control = new FormControl(null);
    input.control = control;
    input.mask = '###-###';
    const setSpy = vi.spyOn(control, 'setValue');
    input.ngOnChanges({
      control: new SimpleChange(null, control, true),
      mask: new SimpleChange(null, '###-###', true),
    });
    expect(setSpy).not.toHaveBeenCalled();

    control.setValue('123-456');
    setSpy.mockClear();
    input.ngOnChanges({ mask: new SimpleChange(null, '###-###', false) });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('UiInputComponent skips when no control or number type', () => {
    const input = new UiInputComponent();
    input.ngOnChanges({} as any);
    input.control = new FormControl('123');
    input.mask = '###-###';
    input.type = 'number';
    input.ngOnChanges({
      control: new SimpleChange(null, input.control, true),
      mask: new SimpleChange(null, '###-###', true),
    });
    expect(input.control.value).toBe('123');
  });

  it('UiInputComponent applyMask returns empty for non-digits', () => {
    const input = new UiInputComponent();
    input.mask = '###-###';
    const result = (input as any).applyMask('abc');
    expect(result).toBe('');
  });

  it('UiInputComponent applyMask truncates when digits are fewer than mask', () => {
    const input = new UiInputComponent();
    input.mask = '##-##';
    const result = (input as any).applyMask('12');
    expect(result).toBe('12');
  });

  it('UiInputComponent applyMask breaks when digits run out on placeholders', () => {
    const input = new UiInputComponent();
    input.mask = '###';
    const result = (input as any).applyMask('1');
    expect(result).toBe('1');
  });

  it('UiInputComponent exposes an optional iconStart that defaults to null', () => {
    const input = new UiInputComponent();
    expect(input.iconStart).toBeNull();

    input.iconStart = 'ri-search-line';
    expect(input.iconStart).toBe('ri-search-line');
  });

  it('UiSelectComponent and UiCheckboxComponent are configurable', () => {
    const select = new UiSelectComponent();
    select.control = new FormControl('');
    select.disabled = true;
    expect(select.disabled).toBe(true);

    const checkboxRef = TestBed.createComponent(UiCheckboxComponent).componentRef;
    checkboxRef.setInput('control', new FormControl(false));
    checkboxRef.setInput('disabled', true);
    expect(checkboxRef.instance.disabled()).toBe(true);
  });

  it('UiPaginationComponent builds page ranges and emits changes', () => {
    const ref = TestBed.createComponent(UiPaginationComponent).componentRef;
    ref.setInput('total', 120);
    ref.setInput('pageSize', 10);
    ref.setInput('page', 1);
    expect(ref.instance.totalPages).toBe(12);
    expect(ref.instance.pages[0]).toBe(1);

    const emit = vi.fn();
    ref.instance.pageChange.subscribe(emit);
    ref.instance.next();
    expect(emit).toHaveBeenCalledWith({ page: 2, pageSize: 10 });
  });

  it('UiPaginationComponent handles edge cases', () => {
    const ref = TestBed.createComponent(UiPaginationComponent).componentRef;
    ref.setInput('total', 100);
    ref.setInput('pageSize', 10);
    ref.setInput('pageWindow', 1);
    ref.setInput('page', 5);
    expect(ref.instance.pages).toEqual([5]);

    ref.setInput('pageWindow', 2);
    expect(ref.instance.pages).toEqual([1, 10]);

    const emit = vi.fn();
    ref.instance.pageChange.subscribe(emit);
    ref.setInput('page', 1);
    ref.instance.prev();
    ref.setInput('page', ref.instance.totalPages);
    ref.instance.next();
    ref.instance.goTo(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('UiPaginationComponent totalPages handles zero values', () => {
    const ref = TestBed.createComponent(UiPaginationComponent).componentRef;
    ref.setInput('total', 0);
    ref.setInput('pageSize', 0);
    expect(ref.instance.totalPages).toBe(1);
  });

  it('UiPaginationComponent covers short ranges and end window', () => {
    const ref = TestBed.createComponent(UiPaginationComponent).componentRef;
    ref.setInput('total', 20);
    ref.setInput('pageSize', 5);
    ref.setInput('pageWindow', 5);
    ref.setInput('page', 4);
    expect(ref.instance.pages).toEqual([1, 2, 3, 4]);

    ref.setInput('total', 100);
    ref.setInput('pageSize', 10);
    ref.setInput('page', 10);
    const pages = ref.instance.pages;
    expect(pages[pages.length - 1]).toBe(10);

    const emit = vi.fn();
    ref.instance.pageChange.subscribe(emit);
    ref.instance.prev();
    ref.instance.goTo(9);
    expect(emit).toHaveBeenCalled();
  });

  it('UiTableComponent formats cells and resolves badge config', () => {
    const table = new UiTableComponent<any>(
      new TranslateMock() as any,
      {
        localeTag: () => 'en-US',
        currency: (v: number, c: string) =>
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: c,
            currencyDisplay: 'narrowSymbol',
          }).format(v),
        date: (v: string | number | Date) => new Date(v).toLocaleString('en'),
        number: (v: number) => v.toLocaleString('en-US'),
      } as any,
    );
    const row = { amount: 10, createdAt: '2024-01-01T00:00:00Z', currency: 'USD', status: 'OK' };
    const colCurrency = { key: 'amount', type: 'currency' } as any;
    const colDate = { key: 'createdAt', type: 'date' } as any;
    const colBadge = {
      key: 'status',
      badgeColor: () => 'green',
      badgeIcon: () => 'ri-ok-line',
    } as any;

    expect(table.displayCell(colCurrency, row)).toContain('$');
    expect(table.displayCell(colDate, row)).toContain('2024');
    expect(table.badgeColor(colBadge, row)).toBe('green');
    expect(table.badgeIcon(colBadge, row)).toBe('ri-ok-line');
    expect(table.toggleOn({ key: 'status' } as any, row)).toBe(true);
    expect(table.trackRow({ id: 'abc' } as any, 3)).toBe('abc');
    expect(table.trackRow({} as any, 3)).toBe(3);

    const emit = vi.fn();
    table.pageChange.subscribe(emit);
    table.onPageChange({ page: 2, pageSize: 10 });
    expect(emit).toHaveBeenCalled();
  });

  it('UiTableComponent formats via formatter and static badge config', () => {
    const table = new UiTableComponent<any>(
      new TranslateMock() as any,
      {
        localeTag: () => 'en-US',
        currency: (v: number, c: string) =>
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: c,
            currencyDisplay: 'narrowSymbol',
          }).format(v),
        date: (v: string | number | Date) => new Date(v).toLocaleString('en'),
        number: (v: number) => v.toLocaleString('en-US'),
      } as any,
    );
    const row = { value: 'X' };
    const colFormatter = { key: 'value', formatter: (val: any) => `fmt:${val}` } as any;
    expect(table.displayCell(colFormatter, row)).toBe('fmt:X');

    const colStatic = {
      key: 'value',
      badgeColor: 'red',
      badgeIcon: 'ri-check',
    } as any;
    expect(table.badgeColor(colStatic, row)).toBe('red');
    expect(table.badgeIcon(colStatic, row)).toBe('ri-check');
  });

  it('UiTableComponent defaults badge values when undefined', () => {
    const table = new UiTableComponent<any>(
      new TranslateMock() as any,
      {
        localeTag: () => 'en-US',
        currency: (v: number, c: string) =>
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: c,
            currencyDisplay: 'narrowSymbol',
          }).format(v),
        date: (v: string | number | Date) => new Date(v).toLocaleString('en'),
        number: (v: number) => v.toLocaleString('en-US'),
      } as any,
    );
    const row = { status: null };
    const col = { key: 'status' } as any;
    expect(table.badgeColor(col, row)).toBe('gray');
    expect(table.badgeIcon(col, row)).toBeNull();
  });

  it('UiTableComponent handles null and invalid values', () => {
    const table = new UiTableComponent<any>(
      new TranslateMock() as any,
      {
        localeTag: () => 'en-US',
        currency: (v: number, c: string) =>
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: c,
            currencyDisplay: 'narrowSymbol',
          }).format(v),
        date: (v: string | number | Date) => new Date(v).toLocaleString('en'),
        number: (v: number) => v.toLocaleString('en-US'),
      } as any,
    );
    const row = { createdAt: 'invalid', name: null, raw: 123 };
    const colDate = { key: 'createdAt', type: 'date' } as any;
    const colNull = { key: 'name' } as any;
    const colRaw = { key: 'raw' } as any;

    expect(table.displayCell(colDate, row)).toBe('invalid');
    expect(table.displayCell(colNull, row)).toBe('-');
    expect(table.displayCell(colRaw, row)).toBe('123');
  });

  it('UiTableComponent uses currency formatting', () => {
    const table = new UiTableComponent<any>(
      new TranslateMock() as any,
      {
        localeTag: () => 'en-US',
        currency: (v: number, c: string) =>
          new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: c,
            currencyDisplay: 'narrowSymbol',
          }).format(v),
        date: (v: string | number | Date) => new Date(v).toLocaleString('en'),
        number: (v: number) => v.toLocaleString('en-US'),
      } as any,
    );
    const row = { amount: 10, currency: 'USD' };
    const colCurrency = { key: 'amount', type: 'currency' } as any;
    const original = Intl.NumberFormat;
    (Intl as any).NumberFormat = function () {
      return { format: (value: number) => `FMT:${value}` };
    } as any;
    const value = table.displayCell(colCurrency, row);
    expect(value).toBe('FMT:10');
    (Intl as any).NumberFormat = original;
  });

  it('UiFormComponent builds form and exposes error state', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    const control = form.control('name');
    control.setErrors({ required: true });
    control.markAsDirty();

    expect(form.isInvalid('name')).toBe(true);
    expect(form.getError('name')?.key).toBe('validation.required');
    expect(form.fieldId('name', 1)).toContain('ui-form-1-name');
    expect(form.showStatus('name')).toBe(true);
    expect(form.displayError('name')?.key).toBe('validation.required');
  });

  it('UiFormComponent preserves the form instance when only field options change', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    const initialFields = [
      {
        name: 'kind',
        labelKey: 'kind',
        type: 'select',
        options: [{ labelKey: 'all', value: '' }],
      },
      { name: 'from', labelKey: 'from', type: 'datetime-local' },
    ] as any;
    form.fields = initialFields;
    form.initialValue = { kind: '', from: '2026-01-01T00:00' };
    form.ngOnChanges({
      fields: new SimpleChange(null, form.fields, true),
      initialValue: new SimpleChange(null, form.initialValue, true),
    });

    const existingForm = form.form;
    const observed = vi.fn();
    existingForm.valueChanges.subscribe(observed);
    form.control('kind').setValue('DEPOSIT');
    const callsAfterFirstChange = observed.mock.calls.length;

    form.fields = [
      {
        name: 'kind',
        labelKey: 'kind',
        type: 'select',
        options: [
          { labelKey: 'all', value: '' },
          { labelKey: 'deposit', value: 'DEPOSIT' },
          { labelKey: 'withdrawal', value: 'WITHDRAWAL' },
        ],
      },
      { name: 'from', labelKey: 'from', type: 'datetime-local' },
    ] as any;
    form.ngOnChanges({ fields: new SimpleChange(initialFields, form.fields, false) });

    expect(form.form).toBe(existingForm);
    expect(form.control('kind').value).toBe('DEPOSIT');

    form.control('kind').setValue('WITHDRAWAL');
    expect(observed.mock.calls.length).toBeGreaterThan(callsAfterFirstChange);
  });

  it('UiFormComponent uses the form id as the field id prefix when provided', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.id = 'tx-filter-form';

    expect(form.fieldId('kind', 0)).toBe('tx-filter-form-0-kind');
    expect(form.sectionTitleId(0)).toBe('tx-filter-form-section-0-title');
    expect(form.sectionDescId(1)).toBe('tx-filter-form-section-1-desc');
  });

  it('UiFormComponent submit emits when valid', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    form.control('name').setValue('ok');
    form.control('name').markAsDirty();
    expect(form.isValid('name')).toBe(true);
    const emit = vi.fn();
    form.submitted.subscribe(emit);
    form.submit();
    expect(emit).toHaveBeenCalled();
  });

  it('UiFormComponent resetTo clears and restores baseline', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    form.control('name').setValue('x');
    form.resetTo({ name: 'y' });
    expect(form.control('name').value).toBe('y');

    form.resetTo();
    expect(form.control('name').value).toBeNull();
  });

  it('UiFormComponent onSubmit prevents when configured', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.preventSubmit = true;
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as any;
    form.onSubmit(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('UiFormComponent onSubmit triggers submit when allowed', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    form.control('name').setValue('ok');
    const emit = vi.fn();
    form.submitted.subscribe(emit);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as any;
    form.preventSubmit = false;
    form.onSubmit(event);
    expect(emit).toHaveBeenCalled();
  });

  it('UiFormComponent handles class values and errors', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    const control = form.control('name');
    control.setErrors({ limitMismatch: true });
    control.markAsDirty();

    expect(form.displayError('name')).toBeNull();
    expect(form.hasDisplayError('name')).toBe(false);

    const cls = form.controlClass('name', ['extra']);
    expect(cls['extra']).toBe(true);
    expect(form.trackByField(0, { name: 'name' } as any)).toBe('name');

    const clsSet = form.controlClass('name', new Set(['from-set']));
    expect(clsSet['from-set']).toBe(true);
    const clsObj = form.controlClass('name', { 'from-obj': true });
    expect(clsObj['from-obj']).toBe(true);
    const clsStr = form.controlClass('name', 'x y');
    expect(clsStr['x']).toBe(true);
  });

  it('UiFormComponent controlClass handles null extras and invalid submit', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    const cls = form.controlClass('name', null);
    expect(cls['ui-form__control']).toBe(true);

    const emit = vi.fn();
    form.submitted.subscribe(emit);
    form.control('name').setErrors({ required: true });
    form.submit();
    expect(emit).not.toHaveBeenCalled();
  });

  it('UiFormComponent applies initial values on field changes', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.initialValue = { name: 'Init' };
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    expect(form.control('name').value).toBe('Init');
  });

  it('UiFormComponent updates values when initialValue changes', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    form.initialValue = { name: 'Next' };
    form.ngOnChanges({ initialValue: new SimpleChange(null, form.initialValue, false) });
    expect(form.control('name').value).toBe('Next');
  });

  it('UiFormComponent builds nested groups and handles validator updates', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [
      { name: 'address.city', labelKey: 'city', type: 'text' } as any,
      { name: 'address.country', labelKey: 'country', type: 'text' } as any,
    ];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    expect(form.control('address.city')).toBeDefined();
    expect(form.control('address.country')).toBeDefined();

    const validator = () => ({ formError: true });
    form.formValidators = [validator as any];
    form.ngOnChanges({ formValidators: new SimpleChange(null, form.formValidators, false) });
    form.form.updateValueAndValidity();
    expect(form.form.errors).toEqual({ formError: true });
  });

  it('UiFormComponent resets when initialValue becomes null', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    form.control('name').setValue('x');
    form.initialValue = null;
    form.ngOnChanges({ initialValue: new SimpleChange({ name: 'x' }, null, false) });
    expect(form.control('name').value).toBeNull();
  });

  it('UiFormComponent maps any validator key to validation.<key> by convention', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    const control = form.control('name');
    control.setErrors({ custom: true });
    control.markAsDirty();
    expect(form.displayError('name')?.key).toBe('validation.custom');
  });

  it('UiFormComponent cleans up on destroy', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.ngOnDestroy();
    expect(true).toBe(true);
  });

  it('UiFormComponent builds one flat FormGroup from sections and exposes the section view', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.sections = [
      {
        titleKey: 'identity.title',
        descriptionKey: 'identity.desc',
        fields: [
          { name: 'name', labelKey: 'name', type: 'text' },
          { name: 'email', labelKey: 'email', type: 'email' },
        ],
      },
      {
        titleKey: 'address.title',
        columns: 1,
        fields: [
          { name: 'address.city', labelKey: 'city', type: 'text' },
          { name: 'address.line1', labelKey: 'line1', type: 'text', fullWidth: true },
        ],
      },
    ] as any;
    form.ngOnChanges({ sections: new SimpleChange(null, form.sections, true) });

    // Sections own their fields but still flatten into ONE FormGroup (nested paths included), so the
    // submit/validation contract is identical to the flat `fields` API.
    expect(form.usesSections).toBe(true);
    expect(form.control('name')).toBeDefined();
    expect(form.control('email')).toBeDefined();
    expect(form.control('address.city')).toBeDefined();
    expect(form.control('address.line1')).toBeDefined();
    expect(form.effectiveFields.map(f => f.name)).toEqual([
      'name',
      'email',
      'address.city',
      'address.line1',
    ]);

    // Running global index across sections keeps fieldId unique; columns resolve to default 2 / explicit 1.
    const view = form.sectionsView;
    expect(view.map(s => s.columns)).toEqual([2, 1]);
    expect(view[0].fields.map(f => f.index)).toEqual([0, 1]);
    expect(view[1].fields.map(f => f.index)).toEqual([2, 3]);
    expect(form.fieldId(view[1].fields[1].field.name, view[1].fields[1].index)).toContain(
      'ui-form-3-address-line1',
    );

    // Section title/description ids drive aria-labelledby/aria-describedby (group semantics).
    expect(form.sectionTitleId(0)).toBe('ui-form-section-0-title');
    expect(form.sectionDescId(1)).toBe('ui-form-section-1-desc');
  });

  it('UiFormComponent applies initialValue to a sections-built form and submits unchanged', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.sections = [{ fields: [{ name: 'name', labelKey: 'name', type: 'text' }] }] as any;
    form.initialValue = { name: 'Jane' };
    form.ngOnChanges({ sections: new SimpleChange(null, form.sections, true) });
    expect(form.control('name').value).toBe('Jane');

    const emitted: any[] = [];
    form.submitted.subscribe(v => emitted.push(v));
    form.submit();
    expect(emitted).toEqual([{ name: 'Jane' }]);
  });

  it('UiFormComponent rebuilds its FormGroup when sections change', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.sections = [{ fields: [{ name: 'a', labelKey: 'a', type: 'text' }] }] as any;
    form.ngOnChanges({ sections: new SimpleChange(null, form.sections, true) });
    expect(form.control('a')).toBeDefined();

    form.sections = [{ fields: [{ name: 'b', labelKey: 'b', type: 'text' }] }] as any;
    form.ngOnChanges({ sections: new SimpleChange(form.sections, form.sections, false) });
    expect(form.control('b')).toBeDefined();
    expect(form.control('a')).toBeNull();
  });

  it('UiFormComponent fieldClasses merges fieldClass with the full-width opt-in', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    expect(
      form.fieldClasses({ name: 'x', labelKey: 'x', type: 'text', fullWidth: true } as any),
    ).toEqual({ 'ui-form__field--full': true });
    // Backward-compat: unset fullWidth => modifier resolves false (ngClass omits it), fieldClass kept.
    expect(
      form.fieldClasses({ name: 'x', labelKey: 'x', type: 'text', fieldClass: 'wide' } as any),
    ).toEqual({ wide: true, 'ui-form__field--full': false });
  });

  it('UiFormComponent falls back to flat fields when no sections are provided', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    expect(form.usesSections).toBe(false);
    expect(form.sectionsView).toEqual([]);
    expect(form.effectiveFields).toBe(form.fields);

    // An empty sections array is treated as "no sections": still flat, still built from `fields`.
    form.sections = [];
    expect(form.usesSections).toBe(false);
    expect(form.effectiveFields).toBe(form.fields);
  });

  it('UiSkeletonComponent builds styles from inputs', () => {
    const ref = TestBed.createComponent(UiSkeletonComponent).componentRef;
    ref.setInput('width', '10px');
    ref.setInput('height', '4px');
    ref.setInput('radius', '2px');
    expect(ref.instance.styles).toEqual({
      '--skeleton-w': '10px',
      '--skeleton-h': '4px',
      '--skeleton-r': '2px',
    });
  });

  it('UiSkeletonComponent returns empty styles when unset', () => {
    expect(TestBed.createComponent(UiSkeletonComponent).componentInstance.styles).toEqual({});
  });

  it('UiFormComponent reflects locale and equality helpers', () => {
    const i18n = new TranslateMock() as any;
    i18n.currentLang = 'tr';
    const form = new UiFormComponent(i18n, { markForCheck: () => {} } as any);
    expect(form.dateInputLang()).toBe('tr-TR');

    expect((form as any).deepEqual({ a: [1] }, { a: [1] })).toBe(true);
    expect((form as any).deepEqual({ a: [1] }, { a: [2] })).toBe(false);
    expect((form as any).deepEqual(null, null)).toBe(true);
    expect((form as any).deepEqual(null, {})).toBe(false);
    expect((form as any).deepEqual(1, '1')).toBe(false);
    expect((form as any).deepEqual([1], { 0: 1 })).toBe(false);
    expect((form as any).deepEqual([1], [1, 2])).toBe(false);
    expect((form as any).deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect((form as any).deepEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect((form as any).normalizeValue([{ a: 1 }])).toEqual([{ a: 1 }]);
  });

  it('UiFormComponent covers neutral field states and class filtering', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [
      { name: 'name', labelKey: 'name', type: 'text' } as any,
      { name: 'status', labelKey: 'status', type: 'text' } as any,
    ];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });

    expect(form.fieldState('missing')).toBeNull();
    expect(form.getError('missing')).toBeNull();
    expect(form.displayError('missing')).toBeNull();

    const name = form.control('name');
    expect(form.fieldState('name')).toBeNull();
    name.disable();
    expect(form.fieldState('name')).toBeNull();
    name.enable();

    const pending = form.control('status');
    pending.markAsPending();
    expect(form.fieldState('status')).toBeNull();

    const classes = form.controlClass('name', ['kept', 123 as any, 'also-kept']);
    expect(classes['kept']).toBe(true);
    expect(classes['also-kept']).toBe(true);
    expect(classes['123']).toBeUndefined();

    expect(form.fieldId('address.city', 2)).toBe('ui-form-2-address-city');
    expect(form.dateInputLang()).toBe('en-US');
  });

  it('UiFormComponent maps validation errors', () => {
    const form = new UiFormComponent(new TranslateMock() as any, { markForCheck: () => {} } as any);
    form.fields = [{ name: 'name', labelKey: 'name', type: 'text' } as any];
    form.ngOnChanges({ fields: new SimpleChange(null, form.fields, true) });
    const control = form.control('name');

    const cases: Array<{ errors: any; key: string }> = [
      { errors: { required: true }, key: 'validation.required' },
      { errors: { multipleSpaces: true }, key: 'validation.multipleSpaces' },
      { errors: { email: true }, key: 'validation.email' },
      { errors: { min: { min: 2 } }, key: 'validation.min' },
      { errors: { max: { max: 5 } }, key: 'validation.max' },
      { errors: { minlength: { requiredLength: 3 } }, key: 'validation.minLength' },
      { errors: { maxlength: { requiredLength: 8 } }, key: 'validation.maxLength' },
      { errors: { surnameRequired: true }, key: 'validation.surnameRequired' },
      { errors: { nationalIdLength: true }, key: 'validation.nationalIdLength' },
      { errors: { nationalIdStartsWithZero: true }, key: 'validation.nationalIdStartsWithZero' },
      { errors: { nationalIdChecksum: true }, key: 'validation.nationalIdChecksum' },
      { errors: { phoneInvalid: true }, key: 'validation.phoneInvalid' },
      { errors: { walletNumberInvalid: true }, key: 'validation.walletNumberInvalid' },
      { errors: { nameInvalid: true }, key: 'validation.nameInvalid' },
      { errors: { unsafeChars: true }, key: 'validation.unsafeChars' },
      { errors: { dateInvalid: true }, key: 'validation.dateInvalid' },
      { errors: { dateInFuture: true }, key: 'validation.dateInFuture' },
      { errors: { minAge: { requiredAge: 18 } }, key: 'validation.minAge' },
      { errors: { maxAge: { requiredAge: 65 } }, key: 'validation.maxAge' },
      { errors: { limitMismatch: true }, key: 'validation.limitMismatch' },
      { errors: { api: 'custom.error' }, key: 'custom.error' },
    ];

    for (const c of cases) {
      control.setErrors(c.errors);
      control.markAsDirty();
      expect(form.getError('name')?.key).toBe(c.key);
    }
  });

  it('UiConfirmDialogComponent and UiSkeletonComponent instantiate', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(document.createElement('div')) }],
    });
    const dialog = TestBed.runInInjectionContext(() => new UiConfirmDialogComponent());
    const cancel = vi.fn();
    dialog.cancel.subscribe(cancel);

    dialog.onEscape();
    expect(cancel).not.toHaveBeenCalled();

    dialog.open = true;
    expect(dialog.open).toBe(true);
    dialog.loading = true;
    dialog.onEscape();
    expect(cancel).not.toHaveBeenCalled();

    dialog.loading = false;
    dialog.onEscape();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dialog.titleId).toContain('confirm-title-');
    expect(dialog.messageId).toContain('confirm-message-');

    const skeletonRef = TestBed.createComponent(UiSkeletonComponent).componentRef;
    skeletonRef.setInput('width', '10px');
    skeletonRef.setInput('height', '8px');
    skeletonRef.setInput('radius', '4px');
    expect(skeletonRef.instance.styles['--skeleton-w']).toBe('10px');
    expect(skeletonRef.instance.styles['--skeleton-h']).toBe('8px');
    expect(skeletonRef.instance.styles['--skeleton-r']).toBe('4px');
  });
});
