/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset screen (`/forgot-password` — REAL backend, factor verified in its OWN step). A
 * self-contained on-screen reset wizard that mirrors the
 * showcase login's Vaultchain design language: identity → verify (second factor) → set new password →
 * done. By product choice there is NO emailed reset link — the operator proves identity with a second
 * factor and sets the password directly.
 *
 * Flow against the contract:
 *   Step 1  email → POST /auth/password/reset/initiate. ALWAYS 202 (no enumeration); the server sets the
 *           httpOnly `ftd_pwreset` cookie ONLY for an eligible MFA account, but the FE never reads it and
 *           ALWAYS advances to step 2.
 *   Step 2  collect a 6-digit TOTP OR a backup code → POST /auth/password/reset/verify-code. The factor
 *           is verified ONCE here (the backend stamps the challenge); 200 → step 3. A bad factor (401
 *           Auth.ResetInvalidCode) keeps the operator on step 2 to re-enter it.
 *   Step 3  collect the new password → POST /auth/password/reset/verify with { newPassword } only (the
 *           factor is already proven). 200 → step 4 (done; sign in fresh at /login — no session issued).
 *   Errors  401 Auth.ResetInvalidCode → stay on step 2 (re-enter the factor); 401 Auth.ResetFactorRequired
 *           (step 3 reached without a verified factor) → back to step 2; 400 Auth.WeakPassword /
 *           Auth.SamePassword → stay on step 3; 401 Auth.ResetChallenge* (missing/expired/consumed) → an
 *           "expired" state with a "start over" action back to step 1; 429 → a rate-limit message.
 *
 * Standalone + OnPush + signals + reactive forms. No reset state (email, password, factor code) is ever
 * persisted to local/session storage; the factor code is sent straight to verify-code and never held.
 * No secret is logged.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { HttpErrorResponse } from '@angular/common/http';
import { finalize } from 'rxjs/operators';
import { PasswordResetApi, type ResetRequestPollStatus } from '@core/api/password-reset.api';
import { extractApiError } from '@core/services/app-error.service';
import {
  AuthBrandPaneComponent,
  type WelcomeSlide,
} from '../../components/auth-brand-pane/auth-brand-pane.component';
import { AuthHeaderControlsComponent } from '../../components/auth-header-controls/auth-header-controls.component';
import { OtpInputComponent } from '../../components/otp-input/otp-input.component';
import { PasswordRulesComponent } from '../../components/password-rules/password-rules.component';
import {
  PASSWORD_MAX,
  passwordPolicyValidator,
  passwordsMatch,
} from '@shared/validators/password-policy';

/** Wizard step: 1 = identify (email), 2 = verify (2nd factor), 3 = set new password, 4 = done. */
type Step = 1 | 2 | 3 | 4;

/**
 * The admin-approval overlay riding on step 2 (A15): `none` = the normal verify form; `form` = the
 * "request an administrator reset" confirmation; `waiting` = the neutral polled waiting state;
 * `denied` = the terminal declined state.
 */
type AdminFlow = 'none' | 'form' | 'waiting' | 'denied';

/** How often the waiting state re-polls the request status (also stated in the on-screen hint copy). */
export const ADMIN_POLL_INTERVAL_MS = 20_000;

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    RouterLink,
    AuthBrandPaneComponent,
    AuthHeaderControlsComponent,
    OtpInputComponent,
    PasswordRulesComponent,
  ],
  templateUrl: './forgot-password.component.html',
  styleUrl: './forgot-password.component.scss',
})
export class ForgotPasswordComponent {
  private readonly fb = inject(FormBuilder);
  private readonly resetApi = inject(PasswordResetApi);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The reset screen's brand-pane copy — kept as the single existing message (so it reads "as now").
   * A 1-element slide list means the shared pane shows it as a static typed headline (no rotation,
   * no dots) while still giving it login's chart + orbs + animations.
   */
  readonly brandSlides: readonly WelcomeSlide[] = [
    { titleKey: 'auth.forgot.brandHeadline', bodyKey: 'auth.forgot.brandBody' },
  ];

  readonly step = signal<Step>(1);
  /** Drives the slide direction of the step transition (forward = from right, back = from left). */
  readonly direction = signal<'forward' | 'back'>('forward');
  readonly submitting = signal(false);
  /** Independent reveal state per field, mirroring the reference (each field has its own eye). */
  readonly showPassword = signal(false);
  readonly showConfirm = signal(false);
  /** The email captured in step 1, echoed back as context on the verify step. */
  readonly email = signal('');

  /** i18n key for the active inline error (null = none); shown in the step's `role="alert"` region. */
  readonly errorKey = signal<string | null>(null);
  /** Interpolation params for `errorKey` (e.g. the `Retry-After` seconds on a 429). */
  readonly errorParams = signal<Record<string, unknown> | undefined>(undefined);
  /** True once the challenge is gone (missing/expired/consumed) — show a "start over" recovery state. */
  readonly expired = signal(false);
  /** Whether the operator switched the verify step to the one-time backup-code path. */
  readonly useBackup = signal(false);

  /** The admin-approval overlay state on step 2 (A15) — see {@link AdminFlow}. */
  readonly adminFlow = signal<AdminFlow>('none');
  /** True while a status poll (auto or manual "check now") is in flight — guards overlapping polls. */
  readonly checkingStatus = signal(false);
  /** The auto-poll timer handle; non-null ONLY in the `waiting` state (cleared on exit/destroy). */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly maxPassword = PASSWORD_MAX;

  readonly steps = [
    { index: 1 as Step, labelKey: 'auth.forgot.steps.identify' },
    { index: 2 as Step, labelKey: 'auth.forgot.steps.verify' },
    { index: 3 as Step, labelKey: 'auth.forgot.steps.reset' },
  ];

  /** 1-based progress for the stepper (clamped so "done" keeps step 3 active with 1–2 ticked). */
  readonly progress = computed(() => Math.min(this.step(), 3));

  @ViewChild(OtpInputComponent) private otp?: OtpInputComponent;

  readonly emailForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  /** TOTP path: exactly 6 digits (server validates the real code). */
  readonly codeForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });

  /** Backup-code path: an `XXXXX-XXXXX`-style single-use code; accept a permissive non-empty value. */
  readonly backupForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(8)]],
  });

  readonly passwordForm = this.fb.nonNullable.group(
    {
      password: ['', [passwordPolicyValidator]],
      confirm: ['', [Validators.required]],
    },
    { validators: [passwordsMatch] },
  );

  constructor() {
    // The poll timer must never outlive the screen (route change / logout while waiting).
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  /** Live confirm-field state for the match indicator (read under OnPush on each input event). */
  matchState(): 'none' | 'match' | 'mismatch' {
    const { password, confirm } = this.passwordForm.getRawValue();
    if (!confirm) return 'none';
    return password === confirm ? 'match' : 'mismatch';
  }

  togglePassword(): void {
    this.showPassword.update(shown => !shown);
  }

  toggleConfirm(): void {
    this.showConfirm.update(shown => !shown);
  }

  /** Switch the verify step between the TOTP and backup-code modes; clears any prior inline error. */
  toggleBackup(): void {
    this.useBackup.update(on => !on);
    this.clearError();
  }

  /**
   * Step 1 → 2: start the reset for this email. The backend ALWAYS returns 202 (no enumeration), so on
   * success we simply advance to the verify step regardless of whether a challenge cookie was set.
   */
  submitEmail(): void {
    if (this.emailForm.invalid || this.submitting()) {
      this.emailForm.markAllAsTouched();
      return;
    }
    const email = this.emailForm.getRawValue().email;
    this.beginRequest('forward');
    this.resetApi
      .initiate(email)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: () => {
          this.email.set(email);
          this.step.set(2);
        },
        error: (err: HttpErrorResponse) => this.applyResetError(err),
      });
  }

  /**
   * Step 2 → 3: verify the second factor (TOTP or backup) at the dedicated verify-code endpoint. The
   * factor is proven ONCE and the backend stamps the challenge — there is nothing held client-side. On
   * success advance to the password step; a bad factor (401 Auth.ResetInvalidCode) keeps us on step 2.
   */
  submitCode(): void {
    if (this.submitting()) return;
    const form = this.useBackup() ? this.backupForm : this.codeForm;
    if (form.invalid) {
      form.markAllAsTouched();
      if (!this.useBackup()) this.otp?.pulseError();
      return;
    }
    this.beginRequest('forward');
    this.resetApi
      .verifyCode(form.getRawValue().code)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: () => this.step.set(3),
        error: (err: HttpErrorResponse) => this.applyResetError(err),
      });
  }

  /**
   * Step 3: fire the verify call with the new password ONLY (the factor was proven at step 2). 200 →
   * done. Errors route by stable code: a missing factor stamp (Auth.ResetFactorRequired) sends the
   * operator back to step 2; a weak/same password stays here; a missing/expired/consumed challenge flips
   * to the "start over" state.
   */
  submitPassword(): void {
    if (this.submitting()) return;
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    const { password } = this.passwordForm.getRawValue();
    this.beginRequest('forward');
    this.resetApi
      .verify(password)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: () => this.step.set(4),
        error: (err: HttpErrorResponse) => this.applyResetError(err),
      });
  }

  /**
   * Step back one (verify → identify, reset → verify). Inside the admin overlay the same control
   * retreats WITHIN the overlay first: the request form returns to the normal verify form. Clears any
   * inline error.
   */
  back(): void {
    if (this.submitting()) return;
    if (this.adminFlow() === 'form') {
      this.adminFlow.set('none');
      this.clearError();
      this.direction.set('back');
      return;
    }
    if (this.step() <= 1) return;
    this.clearError();
    this.direction.set('back');
    this.step.update(s => (s - 1) as Step);
  }

  // --- admin-approval fallback (A15) -----------------------------------------------------------

  /**
   * Open the "request an administrator reset" overlay from the verify step. Visible to EVERYONE by
   * design (whether the account has MFA is never revealed); the email is carried over from step 1.
   */
  openAdminRequest(): void {
    if (this.submitting()) return;
    this.clearError();
    this.direction.set('forward');
    this.adminFlow.set('form');
  }

  /**
   * Send the reset request for the step-1 email. The backend ALWAYS answers 202 with ONE neutral body
   * (unknown account, duplicate request and cooldown included), so success simply enters the neutral
   * waiting state and starts the 20 s status poll.
   */
  submitAdminRequest(): void {
    if (this.submitting()) return;
    this.beginRequest('forward');
    this.resetApi
      .createResetRequest(this.email())
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: () => {
          this.adminFlow.set('waiting');
          this.startPolling();
        },
        error: (err: HttpErrorResponse) =>
          this.applyResetError(err, 'auth.forgot.adminRequest.error.generic'),
      });
  }

  /**
   * Poll the request status once — the shared handler behind BOTH the 20 s auto-poll and the manual
   * "check now" button. Routing: `approved` → the claim already set the `ftd_pwreset` cookie, so leave
   * the overlay and jump to the EXISTING set-new-password step; `denied` → the terminal declined state;
   * `expired` → back to the request form with an inline notice; `pending` → keep waiting.
   */
  checkStatus(): void {
    if (this.checkingStatus()) return;
    this.checkingStatus.set(true);
    this.resetApi
      .requestStatus()
      .pipe(finalize(() => this.checkingStatus.set(false)))
      .subscribe({
        next: res => this.applyRequestStatus(res.status),
        error: (err: HttpErrorResponse) =>
          this.applyResetError(err, 'auth.forgot.adminRequest.error.generic'),
      });
  }

  /** Route the wizard from a poll answer (see {@link checkStatus}); polling stops on every exit. */
  private applyRequestStatus(status: ResetRequestPollStatus): void {
    if (status === 'approved') {
      this.stopPolling();
      this.adminFlow.set('none');
      this.clearError();
      this.direction.set('forward');
      this.step.set(3);
      return;
    }
    if (status === 'denied') {
      this.stopPolling();
      this.clearError();
      this.adminFlow.set('denied');
      return;
    }
    if (status === 'expired') {
      this.stopPolling();
      this.adminFlow.set('form');
      this.errorKey.set('auth.forgot.adminRequest.error.expired');
      this.errorParams.set(undefined);
      return;
    }
    // 'pending' → stay in the waiting state; the interval (or the operator) polls again.
  }

  /** Start the 20 s auto-poll — called ONLY on entering the `waiting` state (never stacked). */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.checkStatus(), ADMIN_POLL_INTERVAL_MS);
  }

  /** Clear the auto-poll timer (state exit, terminal answers, startOver, destroy). Idempotent. */
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Recover from an expired/spent challenge: wipe all entered state and return to step 1 to request a
   * fresh challenge. No reset state survives.
   */
  startOver(): void {
    this.stopPolling();
    this.adminFlow.set('none');
    this.email.set('');
    this.emailForm.reset();
    this.codeForm.reset();
    this.backupForm.reset();
    this.passwordForm.reset();
    this.useBackup.set(false);
    this.expired.set(false);
    this.clearError();
    this.direction.set('back');
    this.step.set(1);
  }

  /** Flip into the in-flight state for a forward step: spinner on, prior error cleared. */
  private beginRequest(direction: 'forward' | 'back'): void {
    this.direction.set(direction);
    this.submitting.set(true);
    this.clearError();
  }

  private clearError(): void {
    this.errorKey.set(null);
    this.errorParams.set(undefined);
  }

  /**
   * Map a reset failure to a localized inline message AND route the wizard (clones LoginComponent's
   * 401/429/400 handling, extended for the reset-specific stable codes). The backend error envelope is
   * `{ error: { code, message } }`; only the stable `code` is consulted — never the raw message.
   * `genericKey` lets the admin-request overlay brand its own unmapped-failure copy while sharing every
   * status-specific branch (429 Retry-After, challenge expiry, …).
   */
  private applyResetError(err: HttpErrorResponse, genericKey = 'auth.forgot.error.generic'): void {
    const code = this.errorCode(err);

    // A missing/expired/consumed challenge can no longer be completed — offer "start over" (step 1).
    if (
      code === 'Auth.ResetChallengeMissing' ||
      code === 'Auth.ResetChallengeInvalid' ||
      code === 'Auth.ResetChallengeConsumed'
    ) {
      this.expired.set(true);
      this.errorKey.set('auth.forgot.error.expired');
      return;
    }

    if (err.status === 429) {
      const seconds = this.parseRetryAfter(err.headers?.get('Retry-After'));
      if (seconds !== null) {
        this.errorKey.set('auth.forgot.error.rateLimitRetry');
        this.errorParams.set({ seconds });
      } else {
        this.errorKey.set('auth.forgot.error.rateLimit');
      }
      return;
    }

    if (err.status === 400 && code === 'Auth.WeakPassword') {
      this.errorKey.set('auth.forgot.error.weakPassword');
      return;
    }
    if (err.status === 400 && code === 'Auth.SamePassword') {
      this.errorKey.set('auth.forgot.error.samePassword');
      return;
    }

    // A wrong/expired factor at verify-code: keep the operator on the verify step to re-enter the code.
    if (err.status === 401 && code === 'Auth.ResetInvalidCode') {
      this.errorKey.set('auth.forgot.error.invalidCode');
      this.direction.set('back');
      this.step.set(2);
      return;
    }

    // Step 3 reached without a verified factor (e.g. challenge re-issued / state desync): send the
    // operator back to step 2 to re-verify the factor before retrying the password.
    if (err.status === 401 && code === 'Auth.ResetFactorRequired') {
      this.errorKey.set('auth.forgot.error.factorRequired');
      this.direction.set('back');
      this.step.set(2);
      return;
    }

    // Anything else (network/5xx/unmapped) → a generic, non-enumerating failure on the current step.
    this.errorKey.set(genericKey);
  }

  /** Read the stable `code` from the backend error envelope (`{ error: { code, message } }`). */
  private errorCode(err: HttpErrorResponse): string {
    const envelope = extractApiError(err.error);
    return typeof envelope?.code === 'string' ? envelope.code : '';
  }

  /** Parse a `Retry-After` header value of delta-seconds into a positive integer, else null. */
  private parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value.trim());
    if (!Number.isInteger(seconds) || seconds <= 0) return null;
    return seconds;
  }
}
