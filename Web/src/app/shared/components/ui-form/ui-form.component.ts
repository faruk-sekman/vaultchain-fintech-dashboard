/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewEncapsulation,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, ValidatorFn } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject, merge } from 'rxjs';
import { startWith, takeUntil } from 'rxjs/operators';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiCheckboxComponent } from '@shared/components/ui-checkbox/ui-checkbox.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import { UiSelectComponent } from '@shared/components/ui-select/ui-select.component';
import { ClassValue, FieldConfig, FormSection } from '@shared/components/ui-form/ui-form.types';

/** A field paired with its position in the flattened field list (drives the unique `fieldId`). */
interface IndexedField {
  field: FieldConfig;
  index: number;
}

/** A section ready for rendering: resolved column count + its fields carrying global indices. */
interface SectionView {
  section: FormSection;
  columns: 1 | 2;
  fields: IndexedField[];
}

function ensureGroup(root: FormGroup, path: string[]): FormGroup {
  let current = root;
  for (const p of path) {
    const existing = current.get(p);
    if (existing instanceof FormGroup) current = existing;
    else {
      const g = new FormGroup({});
      current.addControl(p, g);
      current = g;
    }
  }
  return current;
}

@Component({
  selector: 'app-ui-form',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiInputComponent,
    UiSelectComponent,
    UiCheckboxComponent,
    UiButtonComponent,
  ],
  templateUrl: './ui-form.component.html',
  styleUrl: './ui-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class UiFormComponent implements OnChanges, OnDestroy {
  // Flat field list (the original API). Relaxed from `required` so a consumer can drive the form
  // purely via `sections` instead; existing consumers that bind `[fields]` are unaffected.
  @Input() fields: ReadonlyArray<FieldConfig> = [];
  // Optional grouped layout. When provided (and non-empty) it takes precedence over `fields`: the
  // form is built from every section's fields and rendered grouped. Purely additive + presentational.
  @Input() sections: ReadonlyArray<FormSection> | null = null;
  @Input() initialValue: Record<string, unknown> | null = null;
  @Input() formValidators: ValidatorFn[] | null = null;
  @Input() preventSubmit = false;
  @Input() submitLabelKey = 'common.save';
  @Input() loading = false;
  @Input() id: string | null = null;
  @Input() showSubmit = true;
  @Input() formClass: ClassValue | null = null;
  @Output() submitted = new EventEmitter<Record<string, unknown>>();

  form = new FormGroup({});
  hasChanges = false;
  private initialSnapshot: unknown = null;
  private controlSignature: string | null = null;
  private readonly destroy$ = new Subject<void>();
  private readonly formChanges$ = new Subject<void>();

  constructor(
    private readonly i18n: TranslateService,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    let appliedInitialValue = false;
    // Either input redefines the schema, so both rebuild the single FormGroup the same way.
    if (changes['fields'] || changes['sections']) {
      const nextSignature = this.buildControlSignature();
      if (this.controlSignature !== nextSignature) {
        this.buildForm();
        this.setupFormChangeTracking();
        this.controlSignature = nextSignature;
        if (this.initialValue) {
          this.applyInitialValue();
          appliedInitialValue = true;
        }
        this.setBaselineFromForm();
      } else {
        this.syncValidators();
      }
    } else if (changes['formValidators']) {
      this.form.setValidators(this.formValidators ?? []);
      this.form.updateValueAndValidity({ emitEvent: false });
    }
    if (changes['initialValue'] && !appliedInitialValue) {
      if (this.initialValue) {
        this.applyInitialValue();
      } else {
        this.form.reset(undefined, { emitEvent: false });
      }
      this.setBaselineFromForm();
    }
  }

  ngOnDestroy(): void {
    this.formChanges$.next();
    this.destroy$.next();
    this.destroy$.complete();
    this.formChanges$.complete();
  }

  private buildForm() {
    this.form = new FormGroup({}, { validators: this.formValidators ?? [] });
    for (const f of this.effectiveFields) {
      const parts = f.name.split('.');
      const controlName = parts.pop()!;
      const parent = ensureGroup(this.form, parts);
      parent.addControl(controlName, new FormControl(null, f.validators ?? []));
    }
  }

  private buildControlSignature(): string {
    return this.effectiveFields.map(field => field.name).join('\u001f');
  }

  private syncValidators(): void {
    this.form.setValidators(this.formValidators ?? []);
    for (const f of this.effectiveFields) {
      const control = this.form.get(f.name);
      control?.setValidators(f.validators ?? []);
      control?.updateValueAndValidity({ emitEvent: false });
    }
    this.form.updateValueAndValidity({ emitEvent: false });
  }

  private applyInitialValue(): void {
    this.form.patchValue(this.initialValue ?? {}, { emitEvent: false });
    this.form.markAsPristine();
  }

  /** True when the consumer opted into the grouped layout (non-empty `sections`). */
  get usesSections(): boolean {
    return !!this.sections && this.sections.length > 0;
  }

  /**
   * The single flat field list the FormGroup is built from. Sections (when present) own their fields,
   * so we flatten them; otherwise the original `fields` input is the source of truth. This keeps the
   * submit contract identical for both APIs.
   */
  get effectiveFields(): ReadonlyArray<FieldConfig> {
    if (this.usesSections) {
      return this.sections!.flatMap(section => [...section.fields]);
    }
    return this.fields;
  }

  /**
   * Sections projected for the template: each field is paired with a running global index (so
   * `fieldId` stays unique across sections) and the column count is resolved to its default of 2.
   */
  get sectionsView(): SectionView[] {
    if (!this.sections) return [];
    let index = 0;
    return this.sections.map(section => ({
      section,
      columns: section.columns ?? 2,
      fields: section.fields.map(field => ({ field, index: index++ })),
    }));
  }

  private setupFormChangeTracking() {
    this.formChanges$.next();
    this.form.valueChanges
      .pipe(startWith(this.form.getRawValue()), takeUntil(merge(this.formChanges$, this.destroy$)))
      .subscribe(() => this.updateHasChanges());
  }

  private setBaselineFromForm() {
    this.initialSnapshot = this.normalizeValue(this.form.getRawValue());
    this.hasChanges = false;
  }

  private updateHasChanges() {
    const current = this.normalizeValue(this.form.getRawValue());
    this.hasChanges = !this.deepEqual(current, this.initialSnapshot);
  }

  private normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).reduce(
        (acc, key) => {
          (acc as Record<string, unknown>)[key] = this.normalizeValue(
            (value as Record<string, unknown>)[key],
          );
          return acc;
        },
        {} as Record<string, unknown>,
      );
    }
    return value;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!this.deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const aKeys = Object.keys(a as Record<string, unknown>);
      const bKeys = Object.keys(b as Record<string, unknown>);
      if (aKeys.length !== bKeys.length) return false;
      for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (
          !this.deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
        )
          return false;
      }
      return true;
    }
    return false;
  }

  isInvalid(path: string): boolean {
    return this.fieldState(path) === 'invalid';
  }

  isValid(path: string): boolean {
    return this.fieldState(path) === 'valid';
  }

  fieldState(path: string): 'valid' | 'invalid' | null {
    const c = this.form.get(path);
    if (!c || c.disabled || c.pending) return null;
    // A2 (bugfix-backlog-2026-07): TOUCHED counts too. Dirty-only hid every error a user never
    // typed into (blur an empty required field → nothing) and made submit()'s markAllAsTouched a
    // no-op visually — the "silent no-op" reported as B5.
    if (!c.dirty && !c.touched) return null;
    if (c.invalid) return 'invalid';
    return 'valid';
  }

  showStatus(path: string): boolean {
    return this.fieldState(path) !== null;
  }

  control(path: string): FormControl {
    return this.form.get(path) as FormControl;
  }

  controlClass(path: string, extra?: ClassValue | null): { [csClass: string]: boolean } {
    const state = this.fieldState(path);
    return {
      'ui-form__control': true,
      'ui-form__control--invalid': state === 'invalid',
      'ui-form__control--valid': state === 'valid',
      ...this.classValueToObject(extra),
    };
  }

  /**
   * Classes for a field's wrapper: its own `fieldClass` plus the opt-in full-width modifier. When
   * `fullWidth` is unset the modifier resolves to `false` (ngClass omits it), so existing flat
   * consumers get exactly the classes they got before this change.
   */
  fieldClasses(field: FieldConfig): { [csClass: string]: boolean } {
    return {
      ...this.classValueToObject(field.fieldClass),
      'ui-form__field--full': !!field.fullWidth,
    };
  }

  trackByField = (_: number, field: FieldConfig) => field.name;

  fieldId(name: string, index: number): string {
    const slug = name.replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `${this.idPrefix()}-${index}-${slug}`;
  }

  /** Stable id of a field's error element, referenced by the control's `aria-describedby`. */
  errorId(name: string, index: number): string {
    return `${this.fieldId(name, index)}-error`;
  }

  /** The error id to expose via `aria-describedby` — only while an error is actually shown. */
  describedBy(name: string, index: number): string | null {
    return this.hasDisplayError(name) ? this.errorId(name, index) : null;
  }

  /** Id for a section's title, referenced by the group's `aria-labelledby` so SR names the group. */
  sectionTitleId(index: number): string {
    return `${this.idPrefix()}-section-${index}-title`;
  }

  /** Id for a section's description, referenced by the group's `aria-describedby`. */
  sectionDescId(index: number): string {
    return `${this.idPrefix()}-section-${index}-desc`;
  }

  private idPrefix(): string {
    return this.id?.trim() || 'ui-form';
  }

  dateInputLang(): string {
    if (this.i18n.currentLang === 'tr') return 'tr-TR';
    return 'en-US';
  }

  getError(path: string): { key: string; params?: Record<string, unknown> } | null {
    const c = this.form.get(path);
    if (!c || !c.errors) return null;
    const errors = c.errors;

    // Built-in / cross-cutting validators that carry params or need a remapped key.
    if (errors['required']) return { key: 'validation.required' };
    if (errors['min']) return { key: 'validation.min', params: { min: errors['min'].min } };
    if (errors['max']) return { key: 'validation.max', params: { max: errors['max'].max } };
    if (errors['minlength']) {
      return { key: 'validation.minLength', params: { min: errors['minlength'].requiredLength } };
    }
    if (errors['maxlength']) {
      return { key: 'validation.maxLength', params: { max: errors['maxlength'].requiredLength } };
    }
    // Digit-counting validators (e.g. phone) — "digits", not "characters" (B7).
    if (errors['digitsMin']) {
      return { key: 'validation.digitsMin', params: { min: errors['digitsMin'].min } };
    }
    if (errors['digitsMax']) {
      return { key: 'validation.digitsMax', params: { max: errors['digitsMax'].max } };
    }
    if (errors['minAge']) {
      return { key: 'validation.minAge', params: { min: errors['minAge'].requiredAge } };
    }
    if (errors['maxAge']) {
      return { key: 'validation.maxAge', params: { max: errors['maxAge'].requiredAge } };
    }
    if (errors['api']) return { key: String(errors['api']) };

    // Any other validator maps to `validation.<errorKey>` by convention, so this
    // shared form stays decoupled from app-specific validators (ISP).
    const firstKey = Object.keys(errors)[0];
    return { key: firstKey ? `validation.${firstKey}` : 'validation.invalid' };
  }

  displayError(path: string): { key: string; params?: Record<string, unknown> } | null {
    if (!this.isInvalid(path)) return null;
    const err = this.getError(path);
    if (!err) return null;
    if (err.key === 'validation.limitMismatch') return null;
    return err;
  }

  hasDisplayError(path: string): boolean {
    return this.displayError(path) !== null;
  }

  private classValueToObject(value?: ClassValue | null): { [csClass: string]: boolean } {
    if (!value) return {};
    if (typeof value === 'string') {
      return value
        .split(/\s+/)
        .filter(Boolean)
        .reduce(
          (acc, cls) => {
            acc[cls] = true;
            return acc;
          },
          {} as Record<string, boolean>,
        );
    }
    if (Array.isArray(value)) {
      return value.reduce(
        (acc, item) => {
          if (typeof item === 'string') acc[item] = true;
          return acc;
        },
        {} as Record<string, boolean>,
      );
    }
    if (value instanceof Set) {
      return Array.from(value).reduce(
        (acc, cls) => {
          acc[cls] = true;
          return acc;
        },
        {} as Record<string, boolean>,
      );
    }
    return { ...value };
  }

  onSubmit(event: Event) {
    if (this.preventSubmit) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.submit();
  }

  submit() {
    this.form.markAllAsTouched();
    // OnPush: markAllAsTouched mutates the controls but does not itself schedule a view check, so when
    // submit() is triggered from a parent-owned (content-projected) button the error / red-border state
    // never renders until the user later touches a field inside this component. Mark for check so an
    // empty-form submit surfaces every required-field error immediately (QA #1 — the "silent no-op").
    this.cdr.markForCheck();
    if (this.form.invalid) return;
    this.submitted.emit(this.form.getRawValue());
  }

  resetTo(value?: Record<string, unknown> | null) {
    if (value) {
      this.form.reset(value, { emitEvent: false });
    } else {
      this.form.reset(undefined, { emitEvent: false });
    }
    this.form.markAsPristine();
    this.form.markAsUntouched();
    this.setBaselineFromForm();
  }
}
