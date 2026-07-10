/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA challenge screen (`/mfa/verify`). Reachable only mid-login when
 * `AuthService.mfaPending` is true (enforced by `mfaPendingGuard`). The operator enters a 6-digit
 * TOTP code OR switches to a one-time backup code; on success the access token + principal are set
 * exactly like a normal login and the app routes to the returnUrl (or `/dashboard`). Errors are
 * generic + inline (no enumeration); remember-this-device defaults OFF and is sent only when ticked.
 *
 * Standalone + OnPush + signals + a reactive form. No MFA secret is ever held, logged, or persisted.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import { AuthService } from '@core/auth/auth.service';
import { ThemeService } from '@core/services/theme.service';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';

@Component({
  selector: 'app-mfa-verify',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiAlertComponent,
    UiButtonComponent,
  ],
  templateUrl: './mfa-verify.component.html',
  styleUrl: './mfa-verify.component.scss',
})
export class MfaVerifyComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly themeService = inject(ThemeService);

  readonly theme = this.themeService.theme;

  readonly submitting = signal(false);
  readonly errorKey = signal<string | null>(null);
  /** Whether the operator switched to the backup-code path (different input + endpoint). */
  readonly useBackup = signal(false);

  /** 6-digit TOTP path: exactly 6 digits. */
  readonly totpForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
    rememberDevice: [false],
  });

  /** Backup-code path: an `XXXXX-XXXXX`-style single-use code; accept a permissive non-empty value. */
  readonly backupForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.minLength(8)]],
  });

  /** Stable id for the error region, wired to the active input's `aria-describedby`. */
  readonly errorId = 'mfa-verify-error';

  /** Switch between the TOTP and backup-code entry modes; clears any prior error. */
  toggleBackup(): void {
    this.useBackup.update(on => !on);
    this.errorKey.set(null);
  }

  submit(): void {
    if (this.submitting()) return;
    if (this.useBackup()) {
      this.submitBackup();
      return;
    }
    this.submitTotp();
  }

  private submitTotp(): void {
    if (this.totpForm.invalid) {
      this.totpForm.markAllAsTouched();
      return;
    }
    const { code, rememberDevice } = this.totpForm.getRawValue();
    this.run(this.auth.mfaVerify(code, rememberDevice));
  }

  private submitBackup(): void {
    if (this.backupForm.invalid) {
      this.backupForm.markAllAsTouched();
      return;
    }
    const { code } = this.backupForm.getRawValue();
    this.run(this.auth.mfaVerifyBackupCode(code));
  }

  /**
   * Run a verify call and complete login on success. Last-write-wins is implicit: a fresh submit is
   * blocked while `submitting` is true. Any failure (invalid/expired code, exhausted challenge)
   * resolves to a single generic inline message — no enumeration, no token granted, stay on screen.
   */
  private run(call: ReturnType<AuthService['mfaVerify']>): void {
    this.submitting.set(true);
    this.errorKey.set(null);
    call.pipe(finalize(() => this.submitting.set(false))).subscribe({
      next: () => {
        void this.router.navigateByUrl(this.safeReturnUrl());
      },
      error: () => {
        this.errorKey.set('mfa.verify.error');
      },
    });
  }

  /** Abandon the challenge and return to the login screen (a fresh password step). */
  backToLogin(): void {
    // Clear the pending gate so /mfa/verify is no longer admissible without a new password step.
    this.auth.cancelMfaPending();
    void this.router.navigate(['/login'], {
      queryParams: this.returnUrl() ? { returnUrl: this.returnUrl() } : {},
    });
  }

  private returnUrl(): string | null {
    return this.route.snapshot.queryParamMap.get('returnUrl');
  }

  /** Validate the returnUrl is a same-origin app path before navigating (mirrors LoginComponent). */
  private safeReturnUrl(): string {
    const returnUrl = this.returnUrl();
    if (!returnUrl) return '/dashboard';
    if (!returnUrl.startsWith('/') || returnUrl.startsWith('//') || returnUrl.includes('\\')) {
      return '/dashboard';
    }
    return returnUrl;
  }
}
