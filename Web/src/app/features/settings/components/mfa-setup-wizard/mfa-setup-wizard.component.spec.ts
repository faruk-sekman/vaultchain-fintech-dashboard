/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { ToastService } from '@core/services/toast.service';
import { MfaSetupWizardComponent } from './mfa-setup-wizard.component';

function setup() {
  const auth = {
    mfaSetupStart: vi
      .fn()
      .mockReturnValue(of({ otpauthUri: 'otpauth://x', qrDataUrl: 'data:image/png;base64,x' })),
    mfaSetupConfirm: vi.fn().mockReturnValue(of({ backupCodes: ['AAAA-1111', 'BBBB-2222'] })),
  };
  const router = { navigate: vi.fn() };
  const i18n = { instant: (k: string) => k };
  const toast = { success: vi.fn(), error: vi.fn() };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: i18n },
      { provide: ToastService, useValue: toast },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new MfaSetupWizardComponent());
  return { component, auth, router, toast };
}

describe('MfaSetupWizardComponent (AC5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts at the password step', () => {
    const { component } = setup();
    expect(component.step()).toBe('password');
    expect(component.stepIndex()).toBe(1);
  });

  it('does not start setup with an empty password', () => {
    const { component, auth } = setup();
    component.startSetup();
    expect(auth.mfaSetupStart).not.toHaveBeenCalled();
  });

  it('password → start advances to the confirm step with the QR + manual key', () => {
    const { component, auth } = setup();
    component.passwordForm.setValue({ password: 'Test-Passw0rd!' });
    component.startSetup();
    expect(auth.mfaSetupStart).toHaveBeenCalledWith('Test-Passw0rd!');
    expect(component.step()).toBe('confirm');
    expect(component.qrDataUrl()).toContain('data:image');
    expect(component.otpauthUri()).toBe('otpauth://x');
  });

  it('shows a generic error if start fails (no advance)', () => {
    const { component, auth } = setup();
    auth.mfaSetupStart.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.passwordForm.setValue({ password: 'wrong' });
    component.startSetup();
    expect(component.errorKey()).toBe('mfa.setup.startError');
    expect(component.step()).toBe('password');
  });

  it('confirm → activate shows the one-time backup codes and drops the provisioning data', () => {
    const { component } = setup();
    component.passwordForm.setValue({ password: 'Test-Passw0rd!' });
    component.startSetup();
    component.confirmForm.setValue({ code: '123456' });
    component.confirmSetup();
    expect(component.step()).toBe('backup');
    expect(component.backupCodes()).toEqual(['AAAA-1111', 'BBBB-2222']);
    // The secret/QR is cleared from memory once consumed.
    expect(component.qrDataUrl()).toBeNull();
    expect(component.otpauthUri()).toBeNull();
  });

  it('does not confirm with an invalid (non 6-digit) code', () => {
    const { component, auth } = setup();
    component.confirmForm.setValue({ code: '12' });
    component.confirmSetup();
    expect(auth.mfaSetupConfirm).not.toHaveBeenCalled();
  });

  it('"Done" is gated behind the explicit "I saved these" confirmation, then raises done', () => {
    const { component } = setup();
    const done = vi.fn();
    component.done.subscribe(done);
    component.backupCodes.set(['AAAA-1111']);
    component.step.set('backup');
    // Not confirmed yet → finish() is a no-op (no done event, codes stay).
    component.finish();
    expect(done).not.toHaveBeenCalled();
    expect(component.backupCodes()).toEqual(['AAAA-1111']);

    component.toggleSaved();
    expect(component.savedConfirmed()).toBe(true);
    component.finish();
    // The shell (not the wizard) owns navigation now → finish only raises `done`.
    expect(done).toHaveBeenCalledTimes(1);
    // Codes are cleared from memory on finish (not persisted).
    expect(component.backupCodes()).toEqual([]);
  });

  it('cancel clears any transient secrets and raises cancelled (no router)', () => {
    const { component } = setup();
    const cancelled = vi.fn();
    component.cancelled.subscribe(cancelled);
    component.backupCodes.set(['AAAA-1111']);
    component.qrDataUrl.set('data:image/png;base64,x');
    component.otpauthUri.set('otpauth://x');
    component.savedConfirmed.set(true);
    component.cancel();
    expect(component.backupCodes()).toEqual([]);
    expect(component.qrDataUrl()).toBeNull();
    expect(component.otpauthUri()).toBeNull();
    expect(component.savedConfirmed()).toBe(false);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('copyCodes writes the codes to the clipboard and toasts success', async () => {
    const { component, toast } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    component.backupCodes.set(['AAAA-1111', 'BBBB-2222']);
    component.copyCodes();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('AAAA-1111\nBBBB-2222');
    expect(toast.success).toHaveBeenCalledWith('mfa.setup.copied');
    vi.unstubAllGlobals();
  });

  it('copyCodes toasts an error when the clipboard API is unavailable', () => {
    const { component, toast } = setup();
    vi.stubGlobal('navigator', {});
    component.backupCodes.set(['AAAA-1111']);
    component.copyCodes();
    expect(toast.error).toHaveBeenCalledWith('mfa.setup.copyFailed');
    vi.unstubAllGlobals();
  });

  it('copyCodes toasts an error when a clipboard object exists but writeText is missing', () => {
    const { component, toast } = setup();
    // `navigator.clipboard` present but no `writeText` → the optional-chain guard is falsy, so we take
    // the synchronous else branch (no promise) rather than throwing.
    vi.stubGlobal('navigator', { clipboard: {} });
    component.backupCodes.set(['AAAA-1111']);
    component.copyCodes();
    expect(toast.error).toHaveBeenCalledWith('mfa.setup.copyFailed');
    vi.unstubAllGlobals();
  });

  it('copyCodes toasts an error when the clipboard write is rejected by the browser', async () => {
    const { component, toast } = setup();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    component.backupCodes.set(['AAAA-1111']);
    component.copyCodes();
    // Let the rejected promise's .catch() settle before asserting the failure toast.
    await Promise.resolve();
    await Promise.resolve();
    expect(toast.error).toHaveBeenCalledWith('mfa.setup.copyFailed');
    vi.unstubAllGlobals();
  });

  it('downloadCodes is a no-op when the blob/URL browser APIs are unavailable (SSR-safe guard)', () => {
    const { component } = setup();
    // Strip URL.createObjectURL so the env-guard short-circuits before touching `document`.
    vi.stubGlobal('URL', {});
    const createSpy = vi.spyOn(document, 'createElement');
    component.backupCodes.set(['AAAA-1111']);
    expect(() => component.downloadCodes()).not.toThrow();
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('downloadCodes builds a text blob and triggers an anchor download', () => {
    const { component } = setup();
    const createObjectURL = vi.fn().mockReturnValue('blob:codes');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.fn();
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement;
    const createSpy = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    component.backupCodes.set(['AAAA-1111']);
    component.downloadCodes();

    expect(createObjectURL).toHaveBeenCalled();
    expect(anchor.download).toBe('mfa-backup-codes.txt');
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:codes');
    createSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('shows a generic error if confirm fails (stays on the confirm step)', () => {
    const { component, auth } = setup();
    component.passwordForm.setValue({ password: 'Test-Passw0rd!' });
    component.startSetup();
    auth.mfaSetupConfirm.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.confirmForm.setValue({ code: '123456' });
    component.confirmSetup();
    expect(component.errorKey()).toBe('mfa.setup.confirmError');
    expect(component.step()).toBe('confirm');
  });

  // --- Drawer relocation (deep-link gate, non-dismissibility, lifecycle clear) ---

  it('deep-link auto-open lands on the password step with the seed null (re-auth gate; security req C)', () => {
    // A fresh instance is exactly what the shell mounts on `/settings/mfa` deep-link auto-open.
    const { component, auth } = setup();
    expect(component.step()).toBe('password');
    // The seed/QR is NOT fetched until the password is submitted.
    expect(component.qrDataUrl()).toBeNull();
    expect(component.otpauthUri()).toBeNull();
    expect(auth.mfaSetupStart).not.toHaveBeenCalled();
  });

  it('the backup step is non-dismissible until the codes are saved (security req B)', () => {
    const { component } = setup();
    // Earlier steps are freely cancellable.
    expect(component.dismissBlocked()).toBe(false);
    component.step.set('confirm');
    expect(component.dismissBlocked()).toBe(false);

    // On the backup step, dismissal is blocked WHILE savedConfirmed === false.
    component.step.set('backup');
    component.backupCodes.set(['AAAA-1111']);
    expect(component.dismissBlocked()).toBe(true);

    // Ticking "I have saved these" releases the block so Done/Esc/scrim can close.
    component.toggleSaved();
    expect(component.dismissBlocked()).toBe(false);
  });

  it('emits dismissBlockedChange as the step/saved-gate transitions (drives the drawer disableClose)', () => {
    const { component } = setup();
    const emitted: boolean[] = [];
    component.dismissBlockedChange.subscribe(v => emitted.push(v));
    TestBed.flushEffects();
    // Initial emit on the password step → not blocked.
    expect(emitted.at(-1)).toBe(false);

    component.step.set('backup');
    TestBed.flushEffects();
    expect(emitted.at(-1)).toBe(true);

    component.toggleSaved();
    TestBed.flushEffects();
    expect(emitted.at(-1)).toBe(false);
  });

  it('ngOnDestroy clears the transient secrets even on a path that skips the buttons (security req A)', () => {
    const { component } = setup();
    component.qrDataUrl.set('data:image/png;base64,x');
    component.otpauthUri.set('otpauth://x');
    component.backupCodes.set(['AAAA-1111', 'BBBB-2222']);
    component.savedConfirmed.set(true);

    component.ngOnDestroy();

    expect(component.qrDataUrl()).toBeNull();
    expect(component.otpauthUri()).toBeNull();
    expect(component.backupCodes()).toEqual([]);
    expect(component.savedConfirmed()).toBe(false);
  });
});
