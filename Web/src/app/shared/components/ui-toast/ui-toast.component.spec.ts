/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for UiToastComponent (audit 9C Web). The only custom logic is the toast-type → ui-alert
 * variant mapping; the ngx-toastr `Toast` base is bypassed via Object.create so its lifecycle wiring
 * isn't needed to assert the getter.
 */
import { describe, it, expect } from 'vitest';
import { UiToastComponent } from './ui-toast.component';

function alertTypeFor(toastType: string): string {
  const toast = Object.create(UiToastComponent.prototype) as UiToastComponent;
  (toast as unknown as { toastPackage: { toastType: string } }).toastPackage = { toastType };
  return toast.alertType;
}

describe('UiToastComponent.alertType', () => {
  it.each([
    ['toast-success', 'success'],
    ['toast-error', 'danger'],
    ['toast-warning', 'warning'],
    ['toast-info', 'info'],
    ['toast-unknown', 'info'],
  ])('maps %s -> %s', (toastType, expected) => {
    expect(alertTypeFor(toastType)).toBe(expected);
  });
});
