/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { of, throwError } from 'rxjs';
import { CustomerWalletLimitsComponent } from './customer-wallet-limits.component';
import { WalletsApi } from '@core/api/wallets.api';
import { ToastService } from '@core/services/toast.service';
import { AppErrorService } from '@core/services/app-error.service';
import { TranslateService } from '@ngx-translate/core';

function make(overrides: { updateLimits?: any; getByCustomerId?: any } = {}) {
  const walletsApi = {
    updateLimits:
      overrides.updateLimits ??
      vi.fn(() => of({ id: 'w', dailyLimit: 2, monthlyLimit: 3, currency: 'TRY' } as any)),
    getByCustomerId:
      overrides.getByCustomerId ??
      vi.fn(() =>
        of({ id: 'w', dailyLimit: 55, monthlyLimit: 160, currency: 'TRY', rowVersion: 4 } as any),
      ),
  } as any;
  const toast = { success: vi.fn() } as any;
  const appError = { handleError: vi.fn() } as any;
  const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: WalletsApi, useValue: walletsApi },
      { provide: ToastService, useValue: toast },
      { provide: AppErrorService, useValue: appError },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new CustomerWalletLimitsComponent());
  component.customerId = '1';
  // A7: the save stream now guards on the RBAC gate — grant it by default so the editor-path
  // tests exercise their own concerns; the A7 tests flip it off explicitly.
  component.canManageLimits = true;
  return { component, walletsApi, toast, appError };
}

describe('CustomerWalletLimitsComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('seeds limitsInitialValue when a wallet is set', () => {
    const { component } = make();
    component.wallet = { id: 'w', dailyLimit: 100, monthlyLimit: 400, currency: 'TRY' } as any;
    expect(component.limitsInitialValue()).toEqual({ dailyLimit: 100, monthlyLimit: 400 });
    expect(component.wallet?.id).toBe('w');
  });

  it('formats wallet lifecycle and clamps the limit meter', () => {
    const { component } = make();
    expect(component.walletStatusDisplay()).toBe('wallet.status.ACTIVE');
    expect(component.walletStatusColor()).toBe('green');
    expect(component.limitRatioPercent()).toBe(0);
    expect(component.limitRatioDisplay()).toContain('0');
    expect(component.limitRatioBarClass()).toBe('meter-bar--success');

    component.wallet = { dailyLimit: 2500, monthlyLimit: 10000, status: 'FROZEN' } as any;
    expect(component.walletStatusDisplay()).toBe('wallet.status.FROZEN');
    expect(component.walletStatusColor()).toBe('yellow');
    expect(component.limitRatioPercent()).toBe(25);
    expect(component.limitRatioBarClass()).toBe('meter-bar--success');

    component.wallet = { dailyLimit: 4500, monthlyLimit: 10000, status: 'ACTIVE' } as any;
    expect(component.limitRatioPercent()).toBe(45);
    expect(component.limitRatioBarClass()).toBe('meter-bar--info');

    component.wallet = { dailyLimit: 6500, monthlyLimit: 10000, status: 'ACTIVE' } as any;
    expect(component.limitRatioPercent()).toBe(65);
    expect(component.limitRatioBarClass()).toBe('meter-bar--warning');

    component.wallet = { dailyLimit: 15000, monthlyLimit: 10000, status: 'CLOSED' } as any;
    expect(component.walletStatusColor()).toBe('gray');
    expect(component.limitRatioPercent()).toBe(100);
    expect(component.limitRatioBarClass()).toBe('meter-bar--danger');
  });

  it('guards a non-finite limit ratio', () => {
    const { component } = make();
    component.wallet = { dailyLimit: Number.NaN, monthlyLimit: 100 } as any;
    expect(component.limitRatioPercent()).toBe(0);
  });

  it('resetLimits resets to initial values, then to null when no initial values exist', () => {
    const { component } = make();
    const form = new FormGroup({
      dailyLimit: new FormControl(1),
      monthlyLimit: new FormControl(2),
    });
    component.limitsInitialValue.set({ dailyLimit: 3, monthlyLimit: 4 });
    component.limitsForm = { form } as any;
    component.resetLimits();
    expect(form.get('dailyLimit')?.value).toBe(3);

    component.limitsInitialValue.set(null);
    component.resetLimits();
    expect(form.get('dailyLimit')?.value).toBeNull();
    expect(form.get('monthlyLimit')?.value).toBeNull();
  });

  it('resetLimits exits when form is missing', () => {
    const { component } = make();
    component.limitsForm = undefined;
    expect(() => component.resetLimits()).not.toThrow();
  });

  it('A7: without the permission the fields render read-only and the save stream is inert', () => {
    const { component, walletsApi } = make();
    component.canManageLimits = false;

    // Both limit fields lose their edit affordance…
    expect(component.limitFields.every(f => f.readOnly)).toBe(true);
    // …and even a forced saveLimits() call cannot reach the API (defense-in-depth guard).
    component.limitsForm = {
      form: new FormGroup({
        dailyLimit: new FormControl(10),
        monthlyLimit: new FormControl(100),
      }),
    } as any;
    component.saveLimits();
    expect(walletsApi.updateLimits).not.toHaveBeenCalled();

    // Granting the permission restores the editable fields.
    component.canManageLimits = true;
    expect(component.limitFields.every(f => !f.readOnly)).toBe(true);
  });

  it('saveLimits exits when form is missing or invalid', () => {
    const { component, walletsApi } = make();
    component.limitsForm = undefined;
    component.saveLimits();
    expect(walletsApi.updateLimits).not.toHaveBeenCalled();

    component.limitsForm = {
      form: new FormGroup({
        dailyLimit: new FormControl(null, Validators.required),
        monthlyLimit: new FormControl(3),
      }),
    } as any;
    component.saveLimits();
    expect(walletsApi.updateLimits).not.toHaveBeenCalled();
  });

  it('saveLimits blocks the update and flags limitMismatch when daily >= monthly', () => {
    const { component, walletsApi } = make();
    const form = new FormGroup({
      dailyLimit: new FormControl(10),
      monthlyLimit: new FormControl(5),
    });
    component.limitsForm = { form } as any;
    component.saveLimits();
    expect(walletsApi.updateLimits).not.toHaveBeenCalled();
    expect(form.errors?.['limitMismatch']).toBe(true);
  });

  it('saveLimits clears a stale limitMismatch, posts, toasts, resets, and emits the fresh wallet', () => {
    const { component, walletsApi, toast } = make();
    component.wallet = {
      id: 'w',
      dailyLimit: 1,
      monthlyLimit: 2,
      currency: 'TRY',
      rowVersion: 7,
    } as any;
    const emitSpy = vi.fn();
    component.walletUpdated.subscribe(emitSpy);

    const formStub: any = {
      errors: { limitMismatch: true },
      invalid: false,
      updateValueAndValidity: vi.fn(),
      markAllAsTouched: vi.fn(),
      getRawValue: vi.fn(() => ({ dailyLimit: 1, monthlyLimit: 2 })),
      setErrors: vi.fn(),
      reset: vi.fn(),
      markAsPristine: vi.fn(),
      markAsUntouched: vi.fn(),
    };
    component.limitsForm = { form: formStub } as any;
    component.saveLimits();

    expect(formStub.setErrors).toHaveBeenCalledWith(null);
    expect(walletsApi.updateLimits).toHaveBeenCalledWith('1', {
      dailyLimit: 1,
      monthlyLimit: 2,
      rowVersion: 7,
    });
    expect(toast.success).toHaveBeenCalledWith('wallet.updated');
    expect(formStub.reset).toHaveBeenCalledWith(
      { dailyLimit: 2, monthlyLimit: 3 },
      { emitEvent: false },
    );
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'w', dailyLimit: 2, monthlyLimit: 3 }),
    );
    expect(component.savingLimits()).toBe(false);
  });

  it('saveLimits keeps a co-existing form error when clearing a stale limitMismatch', () => {
    const { component, walletsApi } = make();
    component.wallet = { id: 'w', dailyLimit: 1, monthlyLimit: 2, currency: 'TRY' } as any;
    const setErrors = vi.fn();
    const formStub: any = {
      errors: { limitMismatch: true, otherError: true },
      invalid: false,
      updateValueAndValidity: vi.fn(),
      markAllAsTouched: vi.fn(),
      getRawValue: vi.fn(() => ({ dailyLimit: 1, monthlyLimit: 2 })),
      setErrors,
      reset: vi.fn(),
      markAsPristine: vi.fn(),
      markAsUntouched: vi.fn(),
    };
    component.limitsForm = { form: formStub } as any;
    component.saveLimits();
    // The non-empty remainder branch: the other error survives instead of nulling all errors.
    expect(setErrors).toHaveBeenCalledWith({ otherError: true });
    expect(walletsApi.updateLimits).toHaveBeenCalled();
  });

  it('saveLimits routes an updateLimits error through AppErrorService', () => {
    const { component, appError, walletsApi } = make({
      updateLimits: vi.fn(() => throwError(() => new Error('fail'))),
    });
    component.wallet = { id: 'w', dailyLimit: 1, monthlyLimit: 2, currency: 'TRY' } as any;
    component.limitsForm = {
      form: new FormGroup({ dailyLimit: new FormControl(2), monthlyLimit: new FormControl(3) }),
    } as any;
    component.saveLimits();
    expect(appError.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'updateLimits' }),
    );
    // A non-409 failure must NOT trigger the conflict re-fetch.
    expect(walletsApi.getByCustomerId).not.toHaveBeenCalled();
    expect(component.savingLimits()).toBe(false);
  });

  it('recovers from a 409 conflict: toasts the error, re-fetches, re-seeds the form, and emits', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: {
        error: {
          code: 'Wallets.Conflict',
          message: 'The wallet was modified by someone else. Reload and try again.',
          correlationId: 'corr-1',
        },
      },
    });
    const { component, appError, walletsApi, toast } = make({
      updateLimits: vi.fn(() => throwError(() => conflict)),
    });
    component.wallet = {
      id: 'w',
      dailyLimit: 50,
      monthlyLimit: 150,
      currency: 'TRY',
      rowVersion: 3,
    } as any;
    const emitSpy = vi.fn();
    component.walletUpdated.subscribe(emitSpy);
    const form = new FormGroup({
      dailyLimit: new FormControl(60),
      monthlyLimit: new FormControl(160),
    });
    form.markAsDirty();
    component.limitsForm = { form } as any;

    component.saveLimits();

    // The existing error surface fires (maps to the errors.code.Wallets.Conflict toast)…
    expect(appError.handleError).toHaveBeenCalledWith(
      conflict,
      expect.objectContaining({ operation: 'updateLimits' }),
    );
    expect(toast.success).not.toHaveBeenCalled();
    // …and the wallet is re-fetched so the panel re-seeds with fresh values + rowVersion.
    expect(walletsApi.getByCustomerId).toHaveBeenCalledWith('1');
    expect(component.wallet?.rowVersion).toBe(4);
    expect(component.limitsInitialValue()).toEqual({ dailyLimit: 55, monthlyLimit: 160 });
    expect(form.get('dailyLimit')?.value).toBe(55);
    expect(form.get('monthlyLimit')?.value).toBe(160);
    expect(form.pristine).toBe(true);
    // The parent rail is told about the other operator's change.
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ rowVersion: 4 }));
    expect(component.savingLimits()).toBe(false);
  });

  it('surfaces a failed conflict re-fetch through AppErrorService and keeps the stale form', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'Wallets.Conflict', message: 'conflict', correlationId: 'corr-2' } },
    });
    const { component, appError } = make({
      updateLimits: vi.fn(() => throwError(() => conflict)),
      getByCustomerId: vi.fn(() => throwError(() => new Error('offline'))),
    });
    component.wallet = {
      id: 'w',
      dailyLimit: 50,
      monthlyLimit: 150,
      currency: 'TRY',
      rowVersion: 3,
    } as any;
    const form = new FormGroup({
      dailyLimit: new FormControl(60),
      monthlyLimit: new FormControl(160),
    });
    component.limitsForm = { form } as any;

    component.saveLimits();

    expect(appError.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'reloadWalletAfterConflict' }),
    );
    // The stale form/wallet stay untouched so the operator can retry the reload later.
    expect(component.wallet?.rowVersion).toBe(3);
    expect(form.get('dailyLimit')?.value).toBe(60);
    expect(component.savingLimits()).toBe(false);
  });
});
