/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { ThemeService } from '@core/services/theme.service';
import { MfaVerifyComponent } from './mfa-verify.component';
import verifyTemplate from './mfa-verify.component.html?raw';

function setup(returnUrl: string | null = null) {
  const auth = {
    mfaVerify: vi.fn().mockReturnValue(of({})),
    mfaVerifyBackupCode: vi.fn().mockReturnValue(of({})),
    cancelMfaPending: vi.fn(),
  };
  const router = { navigateByUrl: vi.fn(), navigate: vi.fn() };
  const route = { snapshot: { queryParamMap: { get: vi.fn().mockReturnValue(returnUrl) } } };
  const themeService = { theme: () => 'light' };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: ActivatedRoute, useValue: route },
      { provide: ThemeService, useValue: themeService },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new MfaVerifyComponent());
  return { component, auth, router };
}

function renderTemplate(): Document {
  return new DOMParser().parseFromString(verifyTemplate, 'text/html');
}

describe('MfaVerifyComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('remember-device defaults OFF on first render (AC4)', () => {
    const { component } = setup();
    expect(component.totpForm.controls.rememberDevice.value).toBe(false);
  });

  it('does not call verify when the TOTP code is invalid (not 6 digits)', () => {
    const { component, auth } = setup();
    component.totpForm.controls.code.setValue('12');
    component.submit();
    expect(auth.mfaVerify).not.toHaveBeenCalled();
  });

  it('submits a valid 6-digit code and navigates to the dashboard by default (AC2)', () => {
    const { component, auth, router } = setup();
    component.totpForm.setValue({ code: '123456', rememberDevice: false });
    component.submit();
    expect(auth.mfaVerify).toHaveBeenCalledWith('123456', false);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    expect(component.submitting()).toBe(false);
  });

  it('forwards rememberDevice only when the operator opts in (AC4)', () => {
    const { component, auth } = setup();
    component.totpForm.setValue({ code: '123456', rememberDevice: true });
    component.submit();
    expect(auth.mfaVerify).toHaveBeenCalledWith('123456', true);
  });

  it('honors a safe returnUrl on success', () => {
    const { component, router } = setup('/customers');
    component.totpForm.setValue({ code: '123456', rememberDevice: false });
    component.submit();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/customers');
  });

  it.each(['https://evil.example', '//evil.example', '\\evil'])(
    'falls back to dashboard for unsafe returnUrl %s',
    returnUrl => {
      const { component, router } = setup(returnUrl);
      component.totpForm.setValue({ code: '123456', rememberDevice: false });
      component.submit();
      expect(router.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    },
  );

  it('shows a generic inline error on an invalid code and grants no navigation', () => {
    const { component, auth, router } = setup();
    auth.mfaVerify.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.totpForm.setValue({ code: '000000', rememberDevice: false });
    component.submit();
    expect(component.errorKey()).toBe('mfa.verify.error');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(component.submitting()).toBe(false);
  });

  it('toggles to the backup-code path and verifies via the backup endpoint (AC3)', () => {
    const { component, auth, router } = setup();
    component.toggleBackup();
    expect(component.useBackup()).toBe(true);
    component.backupForm.setValue({ code: 'AAAAA-BBBBB' });
    component.submit();
    expect(auth.mfaVerifyBackupCode).toHaveBeenCalledWith('AAAAA-BBBBB');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/dashboard');
  });

  it('does not submit an empty backup code', () => {
    const { component, auth } = setup();
    component.toggleBackup();
    component.submit();
    expect(auth.mfaVerifyBackupCode).not.toHaveBeenCalled();
  });

  it('is last-write-wins: a second submit while one is in flight is ignored', () => {
    const { component, auth } = setup();
    // A pending (never-emitting) stream keeps `submitting` true so the guard blocks re-entry.
    auth.mfaVerify.mockReturnValueOnce(new Subject());
    component.totpForm.setValue({ code: '123456', rememberDevice: false });
    component.submit();
    component.submit();
    expect(auth.mfaVerify).toHaveBeenCalledTimes(1);
  });

  it('backToLogin navigates to /login (preserving returnUrl when set)', () => {
    const { component, router } = setup('/analytics');
    component.backToLogin();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/analytics' },
    });
  });

  it('clears a prior error when the operator toggles between TOTP and backup modes', () => {
    const { component, auth } = setup();
    // Drive a TOTP failure so an inline error is showing.
    auth.mfaVerify.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.totpForm.setValue({ code: '000000', rememberDevice: false });
    component.submit();
    expect(component.errorKey()).toBe('mfa.verify.error');
    // Switching to backup mode resets the error signal...
    component.toggleBackup();
    expect(component.errorKey()).toBeNull();
    // ...and switching back to TOTP keeps it cleared.
    auth.mfaVerifyBackupCode.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.backupForm.setValue({ code: 'AAAAA-BBBBB' });
    component.submit();
    expect(component.errorKey()).toBe('mfa.verify.error');
    component.toggleBackup();
    expect(component.errorKey()).toBeNull();
  });

  it('rejects a just-too-short backup code and accepts the minimum-valid length (minLength 8)', () => {
    const { component, auth } = setup();
    component.toggleBackup();
    // 7 chars: one below the real minLength(8) validator — invalid, no call.
    component.backupForm.setValue({ code: '1234567' });
    expect(component.backupForm.invalid).toBe(true);
    component.submit();
    expect(auth.mfaVerifyBackupCode).not.toHaveBeenCalled();
    // 8 chars: the boundary minimum — valid, the call goes through.
    component.backupForm.setValue({ code: '12345678' });
    expect(component.backupForm.valid).toBe(true);
    component.submit();
    expect(auth.mfaVerifyBackupCode).toHaveBeenCalledWith('12345678');
  });

  it('shows the SAME generic error for a failed backup verify as for a failed TOTP verify (no enumeration)', () => {
    const { component, auth, router } = setup();

    // A failed TOTP verify resolves to the generic key.
    auth.mfaVerify.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.totpForm.setValue({ code: '000000', rememberDevice: false });
    component.submit();
    const totpError = component.errorKey();

    // Switch to the backup path on the SAME instance and fail there too; the error must be IDENTICAL
    // — no distinct "wrong backup code" message that would let an attacker enumerate which factor hit.
    component.toggleBackup();
    auth.mfaVerifyBackupCode.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.backupForm.setValue({ code: 'AAAAA-BBBBB' });
    component.submit();
    const backupError = component.errorKey();

    expect(totpError).toBe('mfa.verify.error');
    expect(backupError).toBe(totpError);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('backToLogin cancels the pending MFA state so the guard re-blocks the verify screen', () => {
    const { component, auth, router } = setup();
    component.backToLogin();
    expect(auth.cancelMfaPending).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: {} });
  });

  it('the rendered template carries the a11y attributes (one-time-code, numeric, labels)', () => {
    const doc = renderTemplate();
    const code = doc.querySelector('input#mfa-code');
    expect(code).not.toBeNull();
    expect(code?.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code?.getAttribute('inputmode')).toBe('numeric');
    // The remember-device checkbox is a real labelled control.
    expect(doc.querySelector('.mfa-verify__remember input[type="checkbox"]')).not.toBeNull();
    // The error region id used for aria-describedby exists in the alert binding.
    expect(verifyTemplate).toContain('errorId');
    expect(verifyTemplate).toContain("'mfa.verify.codeAria' | translate");
  });
});
