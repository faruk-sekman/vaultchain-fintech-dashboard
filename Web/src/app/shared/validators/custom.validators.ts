/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

function setCtrlError(ctrl: AbstractControl | null, key: string, on: boolean) {
  if (!ctrl) return;
  const errors = ctrl.errors ?? {};
  if (on) {
    if (errors[key]) return;
    ctrl.setErrors({ ...errors, [key]: true });
  } else if (errors[key]) {
    const { [key]: _removed, ...rest } = errors as Record<string, any>;
    if (Object.keys(rest).length) {
      ctrl.setErrors(rest);
      return;
    }
    ctrl.setErrors(null);
  }
}

function numberOrNull(hasValue: boolean, value: unknown): number | null {
  if (hasValue) return Number(value);
  return null;
}

export function walletLimitsConsistencyValidator(
  dailyKey = 'dailyLimit',
  monthlyKey = 'monthlyLimit',
): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const dailyCtrl = group.get(dailyKey);
    const monthlyCtrl = group.get(monthlyKey);
    const dailyRaw = dailyCtrl?.value;
    const monthlyRaw = monthlyCtrl?.value;
    const hasDaily = dailyRaw !== null && dailyRaw !== undefined && dailyRaw !== '';
    const hasMonthly = monthlyRaw !== null && monthlyRaw !== undefined && monthlyRaw !== '';
    const daily = numberOrNull(hasDaily, dailyRaw);
    const monthly = numberOrNull(hasMonthly, monthlyRaw);

    if (daily === null || monthly === null) {
      setCtrlError(dailyCtrl, 'limitMismatch', false);
      setCtrlError(monthlyCtrl, 'limitMismatch', false);
      return null;
    }
    if (!Number.isFinite(daily) || !Number.isFinite(monthly)) return null;

    const hasBlockingError = (ctrl: AbstractControl | null) => {
      if (!ctrl || !ctrl.errors) return false;
      const { limitMismatch, ...rest } = ctrl.errors as Record<string, any>;
      return Object.keys(rest).length > 0;
    };
    if (hasBlockingError(dailyCtrl) || hasBlockingError(monthlyCtrl)) {
      setCtrlError(dailyCtrl, 'limitMismatch', false);
      setCtrlError(monthlyCtrl, 'limitMismatch', false);
      return null;
    }

    const mismatch = daily >= monthly;
    setCtrlError(dailyCtrl, 'limitMismatch', mismatch);
    setCtrlError(monthlyCtrl, 'limitMismatch', mismatch);
    if (mismatch) return { limitMismatch: true };
    return null;
  };
}

export function turkishNationalIdValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    if (raw.startsWith('0')) return { nationalIdStartsWithZero: true };
    if (!/^\d+$/.test(raw)) return { nationalIdNumeric: true };
    if (raw.length !== 11) return { nationalIdLength: true };
    // Official TC Kimlik No checksum (digits 10 and 11) — pure arithmetic, no crypto.
    const d = raw.split('').map(Number);
    const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
    const evenSum = d[1] + d[3] + d[5] + d[7];
    const digit10 = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
    if (digit10 !== d[9]) return { nationalIdChecksum: true };
    const firstTenSum = d.slice(0, 10).reduce((sum, n) => sum + n, 0);
    if (firstTenSum % 10 !== d[10]) return { nationalIdChecksum: true };
    return null;
  };
}

export function trimmedRequiredValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return null;
    if (value.trim().length === 0) return { required: true };
    return null;
  };
}

export function digitsLengthValidator(options: { min?: number; max?: number }): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '');
    if (!raw) return null;
    const digits = raw.replace(/\D+/g, '');
    if (!digits) return null;
    // Dedicated digit-count keys (B7): the old minlength/maxlength reuse rendered the generic
    // "characters" message for a validator that counts DIGITS.
    if (options.min !== undefined && digits.length < options.min) {
      return { digitsMin: { min: options.min, actual: digits.length } };
    }
    if (options.max !== undefined && digits.length > options.max) {
      return { digitsMax: { max: options.max, actual: digits.length } };
    }
    return null;
  };
}

export function noMultipleSpacesValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '');
    if (!raw) return null;
    if (/\s{2,}/.test(raw)) return { multipleSpaces: true };
    return null;
  };
}

export function fullNameValidator(): ValidatorFn {
  const wordRe = /^[\p{L}][\p{L}'-]*$/u;
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    if (/\s{2,}/.test(raw)) return { multipleSpaces: true };
    const parts = raw.split(' ');
    if (parts.length < 2) return { surnameRequired: true };
    for (const part of parts) {
      if (part.length < 2) return { nameInvalid: true };
      if (!wordRe.test(part)) return { nameInvalid: true };
    }
    return null;
  };
}

export function safeTextValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    if (/[<>]/.test(raw)) return { unsafeChars: true };
    if (/[\u0000-\u001F\u007F]/.test(raw)) return { unsafeChars: true };
    return null;
  };
}

export function alphaTextValidator(): ValidatorFn {
  // Letters (any script) plus spaces, hyphens, apostrophes and dots — enough for multi-word place and
  // country names ("New York", "Côte d'Ivoire", "St. Louis") while rejecting digits and symbols. A
  // purely numeric value like "9876" fails (QA #4 — country/city accepted numbers).
  const re = /^[\p{L}][\p{L} .'-]*$/u;
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    return re.test(raw) ? null : { alphaOnly: true };
  };
}

export function postalCodeValidator(): ValidatorFn {
  // Numeric postal code, 4–10 digits (Turkey is 5). Rejects letters like "ABCDE" (QA #3). Paired with a
  // stripPattern on the field so non-digits never enter the model in the first place.
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    return /^\d{4,10}$/.test(raw) ? null : { postalCodeInvalid: true };
  };
}

export function phoneNumberValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    if (!/^\+?\d+$/.test(raw)) return { phoneInvalid: true };
    let digits = raw;
    if (raw.startsWith('+')) {
      digits = raw.slice(1);
    }
    if (!/^[0-9]{7,15}$/.test(digits)) return { phoneInvalid: true };
    return null;
  };
}

export function strictEmailValidator(): ValidatorFn {
  const re = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    if (raw.length > 254) return { email: true };
    const parts = raw.split('@');
    if (parts.length !== 2) return { email: true };
    const [local, domain] = parts;
    if (!local || !domain || local.length > 64) return { email: true };
    if (raw.includes('..')) return { email: true };
    if (re.test(raw)) return null;
    return { email: true };
  };
}

export function dateOfBirthValidator(options?: { minAge?: number; maxAge?: number }): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw = String(control.value ?? '').trim();
    if (!raw) return null;
    const parts = raw.split('-').map(p => Number(p));
    if (parts.length !== 3 || parts.some(p => !Number.isFinite(p))) return { dateInvalid: true };
    const [year, month, day] = parts;
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return { dateInvalid: true };
    const dob = new Date(year, month - 1, day);
    if (dob.getFullYear() !== year || dob.getMonth() !== month - 1 || dob.getDate() !== day)
      return { dateInvalid: true };
    const today = new Date();
    const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (dob > todayMid) return { dateInFuture: true };

    let age = todayMid.getFullYear() - dob.getFullYear();
    const hasBirthdayPassed =
      todayMid.getMonth() > dob.getMonth() ||
      (todayMid.getMonth() === dob.getMonth() && todayMid.getDate() >= dob.getDate());
    if (!hasBirthdayPassed) {
      age -= 1;
    }

    if (options?.minAge && age < options.minAge)
      return { minAge: { requiredAge: options.minAge, actualAge: age } };
    if (options?.maxAge && age > options.maxAge)
      return { maxAge: { requiredAge: options.maxAge, actualAge: age } };
    return null;
  };
}
