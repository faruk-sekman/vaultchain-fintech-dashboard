/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ValidatorFn } from '@angular/forms';

export type FieldType =
  | 'text'
  | 'email'
  | 'number'
  | 'date'
  | 'datetime-local'
  | 'select'
  | 'checkbox';

export interface SelectOption {
  labelKey: string;
  value: any;
}

export type ClassValue = string | string[] | Set<string> | { [csClass: string]: any };

export interface FieldConfig {
  name: string;
  labelKey: string;
  type: FieldType;
  placeholderKey?: string;
  /**
   * Raw, already-resolved placeholder text. Unlike {@link placeholderKey} (an i18n key), this is the
   * literal string to show and takes precedence over `placeholderKey` when set. Used for dynamic,
   * per-instance placeholders that can't be a static translation key — e.g. the customer edit form
   * showing the masked current name/email as a non-editable hint while the control value stays blank.
   */
  placeholder?: string;
  validators?: ValidatorFn[];
  options?: SelectOption[];
  hintKey?: string;
  fieldClass?: ClassValue;
  controlClass?: ClassValue;
  inputMask?: string;
  /**
   * Regex character class of characters to STRIP as the user types (e.g. `[^0-9+]` keeps only
   * digits and `+`). Forwarded to `app-ui-input` so invalid characters never enter the model
   * (A2/B7 phone hardening).
   */
  stripPattern?: string;
  /**
   * Native `maxlength` on the rendered input — caps how many characters can be TYPED. QA found the phone
   * field let >15 digits be entered with the error only surfacing on submit; this stops over-typing at
   * the source. Optional; unset renders no attribute.
   */
  maxLength?: number;
  readOnly?: boolean;
  disabled?: boolean;
  /**
   * Opt-in: render this field spanning every column of a 2-column section grid. Has no effect in a
   * 1-column section or in the flat (sectionless) layout, so it is safe to set unconditionally.
   */
  fullWidth?: boolean;
}

/**
 * Optional visual grouping for {@link FieldConfig}s rendered by `app-ui-form`. A section owns its own
 * slice of fields and renders them under an optional title + description inside a 1- or 2-column
 * responsive grid (2 columns at >=768px). Sections are purely presentational: the form still builds a
 * single flat `FormGroup` from every section's fields, so the submit/`hasChanges`/`resetTo` contract
 * is identical whether a consumer passes flat `fields` or grouped `sections`.
 */
export interface FormSection {
  /** i18n key for the section heading. Omit for an untitled group (header is skipped entirely). */
  titleKey?: string;
  /** i18n key for a short description rendered under the title. */
  descriptionKey?: string;
  /** The fields belonging to this section, in render order. */
  fields: ReadonlyArray<FieldConfig>;
  /** Grid columns at >=768px. Defaults to 2; use 1 for a single-column section. */
  columns?: 1 | 2;
  /** Extra class(es) applied to the section's grid container. */
  sectionClass?: ClassValue;
  /** Optional RemixIcon class rendered as a small medallion before the section title. */
  icon?: string;
}
