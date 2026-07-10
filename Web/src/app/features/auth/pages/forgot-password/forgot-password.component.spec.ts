/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Behaviour spec for the REAL password-reset wizard (factor verified in its OWN step). The flow
 * drives the mocked `PasswordResetApi` seam across THREE calls: initiate →
 * verify-code (Step 2, real factor check) → verify (Step 3, password only). Covers: happy path, invalid
 * email, a bad factor at Step 2 (stay on step 2), the new factor-required gate at Step 3 (back to step
 * 2), weak/same password (stay on step 3), expired challenge (start-over), 429 rate-limit, the
 * backup-code path, empty + double submit, and the template's honesty (Step 2 spinner + no demo copy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { NEVER, of, throwError } from 'rxjs';
import { ADMIN_POLL_INTERVAL_MS, ForgotPasswordComponent } from './forgot-password.component';
import { PasswordResetApi } from '@core/api/password-reset.api';
import forgotTemplate from './forgot-password.component.html?raw';

/** 12+ chars satisfying all 5 rules (len≥12, upper, lower, digit, symbol). */
const STRONG = 'New-Passw0rd!';

/** Build an HttpErrorResponse carrying the backend envelope `{ error: { code } }` (+ optional header). */
function apiError(status: number, code?: string, retryAfter?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: code ? { error: { code, message: code } } : undefined,
    headers: retryAfter ? new HttpHeaders({ 'Retry-After': retryAfter }) : undefined,
  });
}

function setup(
  overrides: Partial<
    Record<'initiate' | 'verifyCode' | 'verify' | 'createResetRequest' | 'requestStatus', unknown>
  > = {},
) {
  const api = {
    initiate: vi.fn(() => of({ status: 'reset_initiated' })),
    verifyCode: vi.fn(() => of({ status: 'code_verified' })),
    verify: vi.fn(() => of({ status: 'reset_complete' })),
    createResetRequest: vi.fn(() => of({ status: 'reset_request_received' })),
    requestStatus: vi.fn(() => of({ status: 'pending' })),
    ...overrides,
  } as unknown as PasswordResetApi & {
    initiate: ReturnType<typeof vi.fn>;
    verifyCode: ReturnType<typeof vi.fn>;
    verify: ReturnType<typeof vi.fn>;
    createResetRequest: ReturnType<typeof vi.fn>;
    requestStatus: ReturnType<typeof vi.fn>;
  };
  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [{ provide: PasswordResetApi, useValue: api }],
  });
  const component = TestBed.runInInjectionContext(() => new ForgotPasswordComponent());
  return { component, api };
}

/** Drive steps 1→2→3 with valid input (verify-code resolves) so a test can focus on the password call. */
function toPasswordStep(component: ForgotPasswordComponent): void {
  component.emailForm.controls.email.setValue('ops@example.com');
  component.submitEmail();
  component.codeForm.controls.code.setValue('123456');
  component.submitCode();
}

describe('ForgotPasswordComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts on the identify step', () => {
    const { component } = setup();
    expect(component.step()).toBe(1);
  });

  it('does not call initiate or advance with an invalid email', () => {
    const { component, api } = setup();
    component.emailForm.controls.email.setValue('not-an-email');
    component.submitEmail();
    expect(api.initiate).not.toHaveBeenCalled();
    expect(component.step()).toBe(1);
  });

  it('happy path: initiate → verify-code (Step 2) → verify password (Step 3) → done', () => {
    const { component, api } = setup();
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    expect(api.initiate).toHaveBeenCalledWith('ops@example.com');
    expect(component.step()).toBe(2);
    expect(component.email()).toBe('ops@example.com');

    // Step 2 now REALLY verifies the factor (calls verify-code) before advancing — not a format-only check.
    component.codeForm.controls.code.setValue('123456');
    component.submitCode();
    expect(api.verifyCode).toHaveBeenCalledWith('123456');
    expect(api.verify).not.toHaveBeenCalled();
    expect(component.step()).toBe(3);

    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(api.verify).toHaveBeenCalledWith(STRONG); // password ONLY — no code
    expect(component.step()).toBe(4);
    expect(component.submitting()).toBe(false);
  });

  it('does not call verify-code unless the TOTP code is exactly 6 digits', () => {
    const { component, api } = setup();
    component.step.set(2);
    component.codeForm.controls.code.setValue('12');
    component.submitCode();
    expect(api.verifyCode).not.toHaveBeenCalled();
    expect(component.step()).toBe(2);
  });

  it('Step 2: a 401 Auth.ResetInvalidCode from verify-code keeps the operator on step 2 with an inline error', () => {
    const { component, api } = setup({
      verifyCode: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetInvalidCode'))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    component.codeForm.controls.code.setValue('000000');
    component.submitCode();
    expect(api.verifyCode).toHaveBeenCalledWith('000000');
    expect(api.verify).not.toHaveBeenCalled();
    expect(component.step()).toBe(2);
    expect(component.errorKey()).toBe('auth.forgot.error.invalidCode');
    expect(component.expired()).toBe(false);
    expect(component.submitting()).toBe(false);
  });

  it('Step 3: a 401 Auth.ResetFactorRequired routes BACK to step 2 to re-verify the factor', () => {
    const { component, api } = setup({
      verify: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetFactorRequired'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(api.verify).toHaveBeenCalledWith(STRONG);
    expect(component.step()).toBe(2);
    expect(component.errorKey()).toBe('auth.forgot.error.factorRequired');
    expect(component.direction()).toBe('back');
    expect(component.expired()).toBe(false);
  });

  it('keeps a 400 Auth.WeakPassword on step 3 with the weak-password error', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(400, 'Auth.WeakPassword'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.step()).toBe(3);
    expect(component.errorKey()).toBe('auth.forgot.error.weakPassword');
  });

  it('keeps a 400 Auth.SamePassword on step 3 with the same-password error', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(400, 'Auth.SamePassword'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.step()).toBe(3);
    expect(component.errorKey()).toBe('auth.forgot.error.samePassword');
  });

  it('Step 2: a consumed/expired challenge from verify-code flips to the expired state', () => {
    const { component } = setup({
      verifyCode: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetChallengeConsumed'))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    component.codeForm.controls.code.setValue('123456');
    component.submitCode();
    expect(component.expired()).toBe(true);
    expect(component.errorKey()).toBe('auth.forgot.error.expired');
  });

  it('Step 3: an expired challenge on verify flips to expired, and start-over resets to step 1', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetChallengeConsumed'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.expired()).toBe(true);
    expect(component.errorKey()).toBe('auth.forgot.error.expired');

    component.startOver();
    expect(component.expired()).toBe(false);
    expect(component.step()).toBe(1);
    expect(component.email()).toBe('');
    expect(component.errorKey()).toBeNull();
  });

  it('shows the timed rate-limit message on a 429 with a Retry-After header', () => {
    const { component } = setup({
      initiate: vi.fn(() => throwError(() => apiError(429, undefined, '45'))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    expect(component.step()).toBe(1);
    expect(component.errorKey()).toBe('auth.forgot.error.rateLimitRetry');
    expect(component.errorParams()).toEqual({ seconds: 45 });
  });

  it('Step 2: a 429 from verify-code shows the timed rate-limit message', () => {
    const { component } = setup({
      verifyCode: vi.fn(() => throwError(() => apiError(429, undefined, '30'))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    component.codeForm.controls.code.setValue('123456');
    component.submitCode();
    expect(component.step()).toBe(2);
    expect(component.errorKey()).toBe('auth.forgot.error.rateLimitRetry');
    expect(component.errorParams()).toEqual({ seconds: 30 });
  });

  it('falls back to the plain rate-limit message on a 429 with no usable Retry-After', () => {
    const { component } = setup({
      initiate: vi.fn(() => throwError(() => apiError(429))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    expect(component.errorKey()).toBe('auth.forgot.error.rateLimit');
    expect(component.errorParams()).toBeUndefined();
  });

  it('verifies via the backup-code path when toggled (verify-code then verify)', () => {
    const { component, api } = setup();
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    component.toggleBackup();
    expect(component.useBackup()).toBe(true);
    component.backupForm.controls.code.setValue('ABCDE-FGHIJ');
    component.submitCode();
    expect(api.verifyCode).toHaveBeenCalledWith('ABCDE-FGHIJ');
    expect(component.step()).toBe(3);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(api.verify).toHaveBeenCalledWith(STRONG);
    expect(component.step()).toBe(4);
  });

  it('does not call verify-code on the backup path with an empty / too-short code', () => {
    const { component, api } = setup();
    component.step.set(2);
    component.toggleBackup();
    component.backupForm.controls.code.setValue('abc');
    component.submitCode();
    expect(api.verifyCode).not.toHaveBeenCalled();
    expect(component.step()).toBe(2);
  });

  it('rejects a password that fails the policy (stays on step 3, no verify call)', () => {
    const { component, api } = setup();
    component.step.set(3);
    component.passwordForm.setValue({ password: 'short1A!', confirm: 'short1A!' });
    component.submitPassword();
    expect(api.verify).not.toHaveBeenCalled();
    expect(component.step()).toBe(3);
    expect(component.passwordForm.controls.password.invalid).toBe(true);
  });

  it('flags a confirmation that does not match', () => {
    const { component } = setup();
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG + 'x' });
    expect(component.matchState()).toBe('mismatch');
    expect(component.passwordForm.hasError('mismatch')).toBe(true);
  });

  it('is last-write-wins: a second submit while one is in flight is ignored', () => {
    const initiate = vi.fn(() => NEVER);
    const { component } = setup({ initiate });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    component.submitEmail();
    expect(initiate).toHaveBeenCalledTimes(1);
    expect(component.submitting()).toBe(true);
  });

  it('back() steps one screen earlier and clears any error', () => {
    const { component } = setup();
    component.step.set(3);
    component.errorKey.set('auth.forgot.error.weakPassword');
    component.back();
    expect(component.step()).toBe(2);
    expect(component.direction()).toBe('back');
    expect(component.errorKey()).toBeNull();
  });

  it('back() is a no-op on the first step (step <= 1 guard)', () => {
    const { component } = setup();
    expect(component.step()).toBe(1);
    component.back();
    expect(component.step()).toBe(1);
  });

  it('back() is a no-op while a request is in flight (submitting guard)', () => {
    const { component } = setup({ initiate: vi.fn(() => NEVER) });
    component.step.set(2);
    component.emailForm.controls.email.setValue('ops@example.com');
    component.step.set(1);
    component.submitEmail();
    component.step.set(3);
    component.back();
    expect(component.step()).toBe(3); // guarded — no step change while submitting
  });

  it('submitCode is a no-op while submitting (guard) and submitPassword too', () => {
    const { component, api } = setup({ initiate: vi.fn(() => NEVER) });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail(); // submitting stays true (NEVER)
    component.step.set(2);
    component.codeForm.controls.code.setValue('123456');
    component.submitCode();
    expect(api.verifyCode).not.toHaveBeenCalled(); // submitCode early-returned
    expect(component.step()).toBe(2);
    component.step.set(3);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(api.verify).not.toHaveBeenCalled(); // submitPassword early-returned
    expect(component.step()).toBe(3);
  });

  it('matchState reports "none" with an empty confirm and "match" when the two are equal', () => {
    const { component } = setup();
    component.passwordForm.setValue({ password: STRONG, confirm: '' });
    expect(component.matchState()).toBe('none');
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    expect(component.matchState()).toBe('match');
  });

  it('toggle helpers flip their reveal/backup signals (and clear the error on backup toggle)', () => {
    const { component } = setup();
    expect(component.showPassword()).toBe(false);
    component.togglePassword();
    expect(component.showPassword()).toBe(true);

    expect(component.showConfirm()).toBe(false);
    component.toggleConfirm();
    expect(component.showConfirm()).toBe(true);

    component.errorKey.set('auth.forgot.error.invalidCode');
    component.toggleBackup();
    expect(component.useBackup()).toBe(true);
    expect(component.errorKey()).toBeNull();
  });

  it('flips to the expired/start-over state on a MISSING challenge (401 Auth.ResetChallengeMissing)', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetChallengeMissing'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.expired()).toBe(true);
    expect(component.errorKey()).toBe('auth.forgot.error.expired');
  });

  it('flips to the expired/start-over state on an INVALID challenge (401 Auth.ResetChallengeInvalid)', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(401, 'Auth.ResetChallengeInvalid'))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.expired()).toBe(true);
  });

  it('falls back to the generic error on an unmapped failure (no stable code / 5xx)', () => {
    const { component } = setup({
      verify: vi.fn(() => throwError(() => apiError(500))),
    });
    toPasswordStep(component);
    component.passwordForm.setValue({ password: STRONG, confirm: STRONG });
    component.submitPassword();
    expect(component.step()).toBe(3);
    expect(component.errorKey()).toBe('auth.forgot.error.generic');
  });

  it('treats a non-positive Retry-After (e.g. "0") as no usable wait (plain rate-limit)', () => {
    const { component } = setup({
      initiate: vi.fn(() => throwError(() => apiError(429, undefined, '0'))),
    });
    component.emailForm.controls.email.setValue('ops@example.com');
    component.submitEmail();
    expect(component.errorKey()).toBe('auth.forgot.error.rateLimit');
    expect(component.errorParams()).toBeUndefined();
  });

  it("exposes a single brand-pane slide built from the screen's own copy (no carousel rotation)", () => {
    const { component } = setup();
    expect(component.brandSlides.length).toBe(1);
    expect(component.brandSlides[0].titleKey).toBe('auth.forgot.brandHeadline');
    expect(component.brandSlides[0].bodyKey).toBe('auth.forgot.brandBody');
  });

  it('renders the real flow: shared panes (demo note OFF), Step 2 verify spinner, inline error, backup toggle, no demo copy', () => {
    const doc = new DOMParser().parseFromString(forgotTemplate, 'text/html');
    expect(forgotTemplate).toContain('<app-auth-brand-pane');
    expect(forgotTemplate).toContain('[showDemoNote]="false"');
    expect(forgotTemplate).toContain('<app-auth-header-controls');
    // The simulated copy is gone.
    expect(forgotTemplate).not.toContain('demoNoteKey');
    expect(forgotTemplate).not.toContain('auth.forgot.verify.demoHint');
    // Step 2 now drives a real async call — its submit shows the verify spinner + working label.
    expect(forgotTemplate).toContain('auth.forgot.working.verify');
    expect(forgotTemplate).toContain('forgot__spinner');
    // The inline error region + backup toggle + start-over are present.
    expect(forgotTemplate).toContain('errorKey()! | translate: errorParams()');
    expect(forgotTemplate).toContain('toggleBackup()');
    expect(forgotTemplate).toContain('startOver()');
    // Accessible inputs + the dedicated OTP + live rules card are retained.
    expect(doc.querySelector('input#forgot-email')?.getAttribute('autocomplete')).toBe('username');
    expect(doc.querySelector('input#forgot-password')?.getAttribute('autocomplete')).toBe(
      'new-password',
    );
    expect(forgotTemplate).toContain('app-otp-input');
    expect(forgotTemplate).toContain('app-password-rules');
  });

  // ===================== A15/A16 — the admin-approval fallback =====================
  describe('admin-approval fallback (A15)', () => {
    afterEach(() => vi.useRealTimers());

    /** Land on step 2 with the step-1 email captured (the overlay rides on the verify step). */
    function toVerifyStep(component: ForgotPasswordComponent): void {
      component.emailForm.controls.email.setValue('ops@example.com');
      component.submitEmail();
    }

    it('renders the ALWAYS-visible admin-request link on the verify step (template honesty)', () => {
      // The link never depends on MFA state — a no-MFA account is indistinguishable by design.
      expect(forgotTemplate).toContain('auth.forgot.adminRequest.link');
      expect(forgotTemplate).toContain('openAdminRequest()');
      // The overlay states + the neutral waiting copy and manual check button are wired.
      expect(forgotTemplate).toContain('auth.forgot.adminRequest.waitingBody');
      expect(forgotTemplate).toContain('auth.forgot.adminRequest.checkNow');
      expect(forgotTemplate).toContain('checkStatus()');
      // The prefilled email is read-only (the request is for the step-1 identity only).
      const doc = new DOMParser().parseFromString(forgotTemplate, 'text/html');
      expect(doc.querySelector('input#forgot-admin-email')?.hasAttribute('readonly')).toBe(true);
    });

    it('openAdminRequest flips the overlay to the request form without leaving step 2', () => {
      const { component } = setup();
      toVerifyStep(component);
      expect(component.adminFlow()).toBe('none');
      component.openAdminRequest();
      expect(component.adminFlow()).toBe('form');
      expect(component.step()).toBe(2);
      expect(component.email()).toBe('ops@example.com');
    });

    it('back() from the request form returns to the verify form (still step 2), clearing errors', () => {
      const { component } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.errorKey.set('auth.forgot.adminRequest.error.generic');
      component.back();
      expect(component.adminFlow()).toBe('none');
      expect(component.step()).toBe(2);
      expect(component.errorKey()).toBeNull();
    });

    it('submitAdminRequest posts the step-1 email and enters the neutral waiting state', () => {
      const { component, api } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      expect(api.createResetRequest).toHaveBeenCalledWith('ops@example.com');
      expect(component.adminFlow()).toBe('waiting');
      expect(component.submitting()).toBe(false);
      expect(component.errorKey()).toBeNull();
    });

    it('waiting auto-polls every 20 s and an approved answer jumps to the EXISTING password step', () => {
      vi.useFakeTimers();
      const { component, api } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      expect(api.requestStatus).not.toHaveBeenCalled(); // no eager poll — the interval owns it

      vi.advanceTimersByTime(ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus).toHaveBeenCalledTimes(1); // pending → keep waiting
      expect(component.adminFlow()).toBe('waiting');

      api.requestStatus.mockReturnValueOnce(of({ status: 'approved' }));
      vi.advanceTimersByTime(ADMIN_POLL_INTERVAL_MS);
      // The claim response set the ftd_pwreset cookie server-side → straight to set-new-password.
      expect(component.step()).toBe(3);
      expect(component.adminFlow()).toBe('none');

      // The timer is gone: more time yields NO further polls.
      const calls = api.requestStatus.mock.calls.length;
      vi.advanceTimersByTime(5 * ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus.mock.calls.length).toBe(calls);
    });

    it('the manual "check now" button drives the same handler and honours the in-flight guard', () => {
      const { component, api } = setup({ requestStatus: vi.fn(() => NEVER) });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      component.checkStatus();
      expect(component.checkingStatus()).toBe(true);
      component.checkStatus(); // second click while in flight → no stacked call
      expect(api.requestStatus).toHaveBeenCalledTimes(1);
    });

    it('a denied answer flips to the terminal denied state and stops the auto-poll', () => {
      vi.useFakeTimers();
      const { component, api } = setup({
        requestStatus: vi.fn(() => of({ status: 'denied' })),
      });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      component.checkStatus();
      expect(component.adminFlow()).toBe('denied');
      const calls = api.requestStatus.mock.calls.length;
      vi.advanceTimersByTime(3 * ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus.mock.calls.length).toBe(calls); // timer cleared
    });

    it('an expired answer returns to the request form with the expired notice and stops polling', () => {
      vi.useFakeTimers();
      const { component, api } = setup({
        requestStatus: vi.fn(() => of({ status: 'expired' })),
      });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      component.checkStatus();
      expect(component.adminFlow()).toBe('form');
      expect(component.errorKey()).toBe('auth.forgot.adminRequest.error.expired');
      const calls = api.requestStatus.mock.calls.length;
      vi.advanceTimersByTime(3 * ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus.mock.calls.length).toBe(calls);
    });

    it('startOver from the admin flow resets the overlay to none and clears the poll timer', () => {
      vi.useFakeTimers();
      const { component, api } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      expect(component.adminFlow()).toBe('waiting');

      component.startOver();
      expect(component.adminFlow()).toBe('none');
      expect(component.step()).toBe(1);
      vi.advanceTimersByTime(3 * ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus).not.toHaveBeenCalled(); // timer cleared before it ever fired
    });

    it('component destroy clears the poll timer (DestroyRef hook)', () => {
      vi.useFakeTimers();
      const { component, api } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();

      // Destroying the testing module destroys the environment injector whose DestroyRef the
      // component registered its cleanup on — the real teardown path a route change takes.
      TestBed.resetTestingModule();
      vi.advanceTimersByTime(3 * ADMIN_POLL_INTERVAL_MS);
      expect(api.requestStatus).not.toHaveBeenCalled();
    });

    it('a 429 on create reuses the shared Retry-After branch (timed rate-limit copy)', () => {
      const { component } = setup({
        createResetRequest: vi.fn(() => throwError(() => apiError(429, undefined, '60'))),
      });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      expect(component.adminFlow()).toBe('form'); // stays on the form to retry later
      expect(component.errorKey()).toBe('auth.forgot.error.rateLimitRetry');
      expect(component.errorParams()).toEqual({ seconds: 60 });
    });

    it('an unmapped create failure surfaces the adminRequest generic copy (not the wizard generic)', () => {
      const { component } = setup({
        createResetRequest: vi.fn(() => throwError(() => apiError(500))),
      });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      expect(component.errorKey()).toBe('auth.forgot.adminRequest.error.generic');
    });

    it('an unmapped status-poll failure keeps waiting with the adminRequest generic copy', () => {
      const { component, api } = setup();
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest();
      api.requestStatus.mockReturnValueOnce(throwError(() => apiError(500)));
      component.checkStatus();
      expect(component.adminFlow()).toBe('waiting');
      expect(component.errorKey()).toBe('auth.forgot.adminRequest.error.generic');
      expect(component.checkingStatus()).toBe(false);
    });

    it('openAdminRequest / submitAdminRequest are no-ops while a request is in flight', () => {
      const { component, api } = setup({ createResetRequest: vi.fn(() => NEVER) });
      toVerifyStep(component);
      component.openAdminRequest();
      component.submitAdminRequest(); // stays in flight (NEVER)
      expect(component.submitting()).toBe(true);
      component.submitAdminRequest(); // guarded
      expect(api.createResetRequest).toHaveBeenCalledTimes(1);
      component.openAdminRequest(); // guarded — the overlay state is untouched mid-flight
      expect(component.adminFlow()).toBe('form');
    });
  });
});
