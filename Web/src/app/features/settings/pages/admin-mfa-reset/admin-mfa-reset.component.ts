/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Administrator MFA-reset screen (`/settings/admin-mfa-reset`). An Administrator
 * (the route + the settings entry are gated on `auth.mfa.admin_reset`; the backend is the real authority
 * and returns 403) resets a locked-out operator's two-step verification: paste the target operator's
 * user ID (UUID), confirm the destructive action, and the backend clears that operator's TOTP, backup
 * codes, and remembered devices.
 *
 * Standalone + OnPush + signals + reactive form. The request is marked SILENT_REQUEST in `MfaApi`, so the
 * ONLY failure surface is this screen's inline alert (no duplicate global toast). Four states: idle,
 * submitting, success, and inline error. No secret/PII is held or logged — only the target user ID.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import { AuthService } from '@core/auth/auth.service';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import {
  UiBreadcrumbComponent,
  type UiBreadcrumbItem,
} from '@shared/components/ui-breadcrumb/ui-breadcrumb.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';

/** Matches the backend `AdminResetMfaDto` UUID rule exactly so the FE rejects a bad id before the call. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID validator that TRIMS before testing — a pasted id often carries a trailing space/newline, and the
 * value we ultimately send is trimmed too, so the field shouldn't flag whitespace-padded-but-valid input.
 * An empty value yields no `pattern` error here (the separate `required` validator owns emptiness).
 */
function trimmedUuidValidator(control: AbstractControl): ValidationErrors | null {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (value === '') return null;
  return UUID_PATTERN.test(value) ? null : { pattern: true };
}

@Component({
  selector: 'app-admin-mfa-reset',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    TranslateModule,
    UiAlertComponent,
    UiBreadcrumbComponent,
    UiButtonComponent,
    UiCardComponent,
    UiConfirmDialogComponent,
    UiInputComponent,
  ],
  templateUrl: './admin-mfa-reset.component.html',
  styleUrl: './admin-mfa-reset.component.scss',
})
export class AdminMfaResetComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly breadcrumbItems: UiBreadcrumbItem[] = [
    { labelKey: 'nav.settings', link: '/settings' },
    { labelKey: 'settings.sections.security' },
    { labelKey: 'mfa.adminReset.pageTitle' },
  ];

  /** The reactive form: a single target-user-id field, required + UUID-shaped (trim-tolerant). */
  readonly form = this.fb.nonNullable.group({
    userId: ['', [Validators.required, trimmedUuidValidator]],
  });

  readonly submitting = signal(false);
  /** True once a reset has succeeded — swaps the form for the success panel + "reset another". */
  readonly succeeded = signal(false);
  /** The inline error i18n key (null when none); the single failure surface for this screen. */
  readonly errorKey = signal<string | null>(null);
  /** Whether the destructive-confirm dialog is open. */
  readonly confirmOpen = signal(false);

  /** Stable ids so the input's error message wires up via aria-describedby. */
  readonly inputId = 'admin-mfa-reset-user-id';
  readonly errorId = 'admin-mfa-reset-validation';
  readonly hintId = 'admin-mfa-reset-hint';

  private readonly userIdControl = this.form.controls.userId;

  /**
   * Show the inline field validation message only once the control is touched/dirty and invalid. Plain
   * methods (NOT computed) so the OnPush template re-reads the reactive-form state on every CD pass —
   * `FormControl.touched/hasError` are not signals, so a `computed` would memoize the first value.
   */
  showRequired(): boolean {
    return this.fieldError('required');
  }
  showUuid(): boolean {
    return this.fieldError('pattern');
  }

  /** Open the destructive-confirm dialog when the form is valid; otherwise reveal the field error. */
  askReset(): void {
    if (this.submitting()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.errorKey.set(null);
    this.confirmOpen.set(true);
  }

  /** Cancel from the confirm dialog — no request is made. */
  cancelReset(): void {
    this.confirmOpen.set(false);
  }

  /** Confirmed: call the admin-reset passthrough; map any failure to a single inline message. */
  confirmReset(): void {
    if (this.submitting() || this.form.invalid) return;
    this.confirmOpen.set(false);
    this.submitting.set(true);
    this.errorKey.set(null);
    this.auth
      .mfaAdminReset(this.userIdControl.getRawValue().trim())
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: () => this.succeeded.set(true),
        error: (err: HttpErrorResponse) => this.applyError(err),
      });
  }

  /** Clear the success panel + form to reset another operator. */
  resetAnother(): void {
    this.succeeded.set(false);
    this.errorKey.set(null);
    this.form.reset({ userId: '' });
  }

  /** Return to the Settings security section, where this recovery screen is launched from. */
  backToSecurity(): void {
    void this.router.navigate(['/settings'], {
      queryParams: { section: 'security' },
    });
  }

  /**
   * Map a reset failure to ONE localized inline key by HTTP status (the backend is the authority):
   *   403 → you cannot reset your own MFA here · 404/400 → no operator matches that id ·
   *   429 → rate-limited · anything else (network/5xx) → generic.
   */
  private applyError(err: HttpErrorResponse): void {
    switch (err.status) {
      case 403:
        this.errorKey.set('mfa.adminReset.error.selfReset');
        break;
      case 404:
      case 400:
        this.errorKey.set('mfa.adminReset.error.invalidTarget');
        break;
      case 429:
        this.errorKey.set('mfa.adminReset.error.rateLimit');
        break;
      default:
        this.errorKey.set('mfa.adminReset.error.generic');
    }
  }

  /** True when the user-id control has the given error AND has been interacted with. */
  private fieldError(error: 'required' | 'pattern'): boolean {
    const c = this.userIdControl;
    return c.hasError(error) && (c.touched || c.dirty);
  }
}
