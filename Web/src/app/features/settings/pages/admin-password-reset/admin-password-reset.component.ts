/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Administrator password-reset screen (`/admin-password-reset`). The TWIN of
 * `admin-mfa-reset.component` (Package 2 of the auth-ux plan): an Administrator — the route + the
 * Settings entry are gated on `auth.password.admin_reset`, and the backend is the real authority and
 * returns 403 — sets a LOCKED-OUT operator's password as a recovery path (self-service `/forgot-password`
 * stays the primary, no-approval flow).
 *
 * Picker = Option 2b: it consumes the admin-only `GET /users` (gated server-side by `users.manage`) and
 * offers a native token-styled <select> of operators; if that list 403s/fails, it degrades to a manual
 * UUID-paste field with the SAME trim-tolerant pattern validation as admin-mfa-reset. The new-password
 * field reuses the shared `password-policy` (12–64, upper/lower/digit/symbol — the exact backend rule):
 * a reveal toggle + a one-click Generate (CSPRNG, policy-guaranteed) sit beside it, and the inline
 * strength meter + live requirements checklist are driven by the SAME `evaluatePassword`, so the
 * on-screen meter never passes a password the server would 400.
 *
 * Standalone + OnPush + signals + reactive form. The admin-reset request is marked SILENT_REQUEST in
 * `PasswordResetApi`, so the ONLY failure surface is this screen's inline alert (no duplicate global
 * toast). States: idle, submitting, success, and inline error. HONEST destructive copy: it revokes
 * sessions / trusted devices / open reset+MFA challenges and resets the PASSWORD — it does NOT remove
 * the target's MFA/authenticator (that is admin MFA-reset). The new password is never logged. The
 * target user id and the password are held only transiently in the form.
 *
 * EK-2: the reset-REQUESTS review queue (`AdminResetRequestsComponent`) is embedded as the BOTTOM
 * section of this page — one admin recovery surface. Deep links land here as `?request=<id>`, which
 * the embedded section reads off this route to preselect + scroll to that request.
 */
import { LocaleFormatService } from '@core/services/locale-format.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  AbstractControl,
  FormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import { RbacApi, RbacUser } from '@core/api/rbac.api';
import { AuthService } from '@core/auth/auth.service';
import { AdminResetRequestsComponent } from '../../components/admin-reset-requests/admin-reset-requests.component';
import { type RelativeTime, relativeTime } from '@shared/utils/relative-time.util';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  STRENGTH_LABEL_KEYS,
  evaluatePassword,
  passwordPolicyValidator,
} from '@shared/validators/password-policy';

/** Matches the backend UUID rule exactly so the FE rejects a bad pasted id before the call. */
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
  selector: 'app-admin-password-reset',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminResetRequestsComponent,
    DatePipe,
    ReactiveFormsModule,
    TranslateModule,
    UiAlertComponent,
    UiButtonComponent,
    UiCardComponent,
    UiConfirmDialogComponent,
    UiInputComponent,
  ],
  templateUrl: './admin-password-reset.component.html',
  styleUrl: './admin-password-reset.component.scss',
})
export class AdminPasswordResetComponent {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly rbac = inject(RbacApi);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The reactive form. `targetUserId` is the chosen operator (from the picker) OR a pasted UUID; it is
   * required + UUID-shaped (trim-tolerant). `newPassword` mirrors the backend policy exactly via the
   * shared `passwordPolicyValidator` (12–64 + upper/lower/digit/symbol).
   */
  readonly form = this.fb.nonNullable.group({
    targetUserId: ['', [Validators.required, trimmedUuidValidator]],
    newPassword: [
      '',
      [Validators.required, Validators.maxLength(PASSWORD_MAX), passwordPolicyValidator],
    ],
  });

  /** The loaded operator roster for the picker (empty until `GET /users` resolves; empty on 403/fail). */
  readonly users = signal<readonly RbacUser[]>([]);
  /** True while the operator list is loading (drives the picker's loading hint). */
  readonly usersLoading = signal(false);
  /**
   * True when the operator list could not be loaded (403 without `users.manage`, or a network error) —
   * the screen then degrades to the manual UUID-paste field instead of the dropdown. This is NOT an
   * error surface; the manual path is fully functional, so it shows an informational hint only.
   */
  readonly usersFallback = signal(false);

  readonly submitting = signal(false);
  /** True once a reset has succeeded — swaps the form for the success panel + "reset another". */
  readonly succeeded = signal(false);
  /** The inline error i18n key (null when none); the single failure surface for this screen. */
  readonly errorKey = signal<string | null>(null);
  /** Whether the destructive-confirm dialog is open. */
  readonly confirmOpen = signal(false);

  /** Live mirror of the new-password value so the OnPush strength card re-reads it on every keystroke. */
  readonly passwordValue = signal('');

  /**
   * Live evaluation of the entered password against the shared policy (12–64 + upper/lower/digit/symbol).
   * Drives the inline strength meter + requirements checklist, and is the SAME source of truth as the
   * reactive-form `passwordPolicyValidator`, so what turns green is exactly what gates the submit.
   * Presentation-only (no behaviour change): the form/validator still own gating; this only renders.
   */
  readonly evaluation = computed(() => evaluatePassword(this.passwordValue()));
  /** i18n key for the current strength label (empty string when the field is empty). */
  readonly strengthLabelKey = computed(() => STRENGTH_LABEL_KEYS[this.evaluation().score]);
  /** The four strength-meter segments (1..4); a segment is lit when `score >= n`. */
  readonly strengthSegments = [1, 2, 3, 4] as const;

  /** Reveal/mask the temporary-password value (the field starts masked). */
  readonly showPassword = signal(false);

  /** Whether the custom operator dropdown (the rich closed control + its listbox) is open. */
  readonly pickerOpen = signal(false);

  /**
   * The currently-selected operator, resolved from `targetUserId` against the loaded roster — or null
   * when nothing is chosen yet (the closed control then shows its placeholder). The control remains the
   * single source of truth; this only mirrors it for the closed-state presentation.
   */
  readonly selectedUser = computed<RbacUser | null>(() => {
    const id = this.userIdValue();
    return this.users().find(user => user.id === id) ?? null;
  });

  /** Stable ids so the inputs' messages wire up via aria-describedby. */
  readonly userInputId = 'admin-pw-reset-user-id';
  readonly userErrorId = 'admin-pw-reset-user-validation';
  readonly userHintId = 'admin-pw-reset-user-hint';
  readonly pickerId = 'admin-pw-reset-picker';
  readonly pickerListId = 'admin-pw-reset-picker-list';
  readonly passwordInputId = 'admin-pw-reset-password';
  readonly passwordErrorId = 'admin-pw-reset-password-validation';

  /** Live mirror of the target-id control so OnPush re-resolves `selectedUser` as the picker writes. */
  private readonly userIdValue = signal('');

  private readonly userIdControl = this.form.controls.targetUserId;
  private readonly passwordControl = this.form.controls.newPassword;

  constructor() {
    this.loadUsers();
    // Keep the strength card in lock-step with the password control (OnPush-safe live read).
    this.passwordControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(value => this.passwordValue.set(value ?? ''));
    // Mirror the target-id control so the custom dropdown's `selectedUser` re-resolves on every write
    // (from the listbox or a manual UUID paste) without coupling presentation to the control's getter.
    this.userIdControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(value => this.userIdValue.set(value ?? ''));
  }

  /**
   * Load the admin-only operator roster for the picker. A 403 (the admin lacks `users.manage`) or any
   * failure flips `usersFallback` so the screen uses the manual UUID field — the reset itself still works
   * (it is gated by `auth.password.admin_reset`, a different permission). Never throws to the template.
   */
  private loadUsers(): void {
    this.usersLoading.set(true);
    this.rbac
      .listUsers()
      .pipe(
        finalize(() => this.usersLoading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: users => {
          this.users.set(users);
          this.usersFallback.set(users.length === 0);
        },
        error: () => this.usersFallback.set(true),
      });
  }

  /**
   * Show the target-id field validation only once the control is touched/dirty and invalid. Plain
   * methods (NOT computed) so the OnPush template re-reads the reactive-form state on every CD pass —
   * `FormControl.touched/hasError` are not signals, so a `computed` would memoize the first value.
   */
  showUserRequired(): boolean {
    return this.fieldError(this.userIdControl, 'required');
  }
  showUserUuid(): boolean {
    return this.fieldError(this.userIdControl, 'pattern');
  }

  /** Show the password policy message once the control is interacted with and fails the policy. */
  showPasswordPolicy(): boolean {
    const c = this.passwordControl;
    return (c.hasError('policy') || c.hasError('required') || c.hasError('maxlength')) &&
      (c.touched || c.dirty)
      ? true
      : false;
  }

  /** Open the destructive-confirm dialog when the whole form is valid; otherwise reveal field errors. */
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

  /** Confirmed: call the admin password-reset passthrough; map any failure to a single inline message. */
  confirmReset(): void {
    if (this.submitting() || this.form.invalid) return;
    this.confirmOpen.set(false);
    this.submitting.set(true);
    this.errorKey.set(null);
    this.auth
      .adminResetPassword(
        this.userIdControl.getRawValue().trim(),
        this.passwordControl.getRawValue(),
      )
      .pipe(
        finalize(() => this.submitting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.succeeded.set(true);
          // Drop the entered password from the form the instant the reset lands (no lingering secret).
          this.passwordControl.reset('');
          this.passwordValue.set('');
        },
        error: (err: HttpErrorResponse) => this.applyError(err),
      });
  }

  /** Clear the success panel + form to reset another operator. */
  resetAnother(): void {
    this.succeeded.set(false);
    this.errorKey.set(null);
    this.showPassword.set(false);
    this.form.reset({ targetUserId: '', newPassword: '' });
    this.passwordValue.set('');
  }

  /** Toggle the temporary-password reveal (visual affordance; never logged). */
  toggleShow(): void {
    this.showPassword.set(!this.showPassword());
  }

  /** Open/close the custom operator dropdown (the rich closed control + its listbox). */
  togglePicker(): void {
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Close the dropdown (Escape, click-outside, or after a choice). */
  closePicker(): void {
    this.pickerOpen.set(false);
  }

  /** Close the dropdown on Escape (matches the app's modal convention); no-op when already closed. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.pickerOpen()) this.closePicker();
  }

  /**
   * Choose an operator from the listbox: write its id into the SAME `targetUserId` control the manual
   * field uses, mark it touched/dirty so validation behaves identically, and close the dropdown.
   */
  selectUser(user: RbacUser): void {
    this.userIdControl.setValue(user.id);
    this.userIdControl.markAsDirty();
    this.userIdControl.markAsTouched();
    this.closePicker();
  }

  /**
   * Up to two uppercase initials from a display name (mirrors `app-ui-avatar`) for the picker avatar.
   * Presentation-only; derived from the name we already hold (no extra PII).
   */
  initialsFor(name: string): string {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
    return (first + last).toUpperCase();
  }

  /**
   * Lightly mask a display name for the closed control / listbox — keep the first letter of each word,
   * replace the rest with `*` (e.g. "Mert Kaya" → "Mert K***" style). PII-minimal by default; the raw
   * name is never sent anywhere (only the id is). Single-letter / empty words pass through unchanged.
   */
  maskName(name: string): string {
    return (name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(word =>
        word.length <= 1 ? word : `${word[0]}${'*'.repeat(Math.min(word.length - 1, 3))}`,
      )
      .join(' ');
  }

  /**
   * Bucket a `lastLoginAt` ISO into the SAME relative-time shape the notifications feed uses (static
   * i18n key + params, or `absolute` for ≥7 days). Presentation-only; the value comes straight from the
   * real `GET /users` row. The "never signed in" (null) case is handled by the template (em-dash), so a
   * caller only reaches here with a non-null timestamp.
   */
  lastLoginTime(iso: string): RelativeTime {
    return relativeTime(iso);
  }

  /**
   * Fill the field with a fresh policy-passing temporary password and reveal it so the admin can read it
   * off to relay over a secure channel. It is generated with `crypto.getRandomValues` (no `Math.random`),
   * guaranteed to satisfy every rule (≥12 with upper/lower/digit/symbol), and written through the normal
   * control so the validator + live meter update. The value is held only in the form and never logged.
   */
  generatePassword(): void {
    if (this.submitting()) return;
    const generated = this.makeTempPassword();
    this.passwordControl.setValue(generated);
    this.passwordControl.markAsDirty();
    this.passwordControl.markAsTouched();
    this.passwordValue.set(generated);
    this.showPassword.set(true);
  }

  /** Build a random temp password that always passes the policy (length 16, every class present). */
  private makeTempPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digit = '23456789';
    const symbol = '!?@#$%&*';
    const all = upper + lower + digit + symbol;
    const pick = (set: string, n: number): string =>
      Array.from(this.randomBytes(n), byte => set[byte % set.length]).join('');
    // Guarantee one of each class, then fill to 16, then shuffle so the classes aren't positional.
    const seed = pick(upper, 1) + pick(lower, 1) + pick(digit, 1) + pick(symbol, 1);
    const chars = (seed + pick(all, PASSWORD_MIN)).slice(0, 16).split('');
    for (let i = chars.length - 1; i > 0; i--) {
      const j = this.randomBytes(1)[0] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  /** CSPRNG bytes (falls back to a non-crypto source only if the Web Crypto API is unavailable). */
  private randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    const webCrypto = globalThis.crypto;
    if (webCrypto?.getRandomValues) {
      webCrypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytes;
  }

  /**
   * Map a reset failure to ONE localized inline key by HTTP status (the backend is the authority):
   *   403 → you cannot reset your own password here · 404 → no operator matches that id ·
   *   400 → the password is too weak or unchanged · 429 → rate-limited ·
   *   anything else (network/5xx) → generic.
   */
  private applyError(err: HttpErrorResponse): void {
    switch (err.status) {
      case 403:
        this.errorKey.set('password.adminReset.error.selfReset');
        break;
      case 404:
        this.errorKey.set('password.adminReset.error.unknown');
        break;
      case 400:
        this.errorKey.set('password.adminReset.error.weak');
        break;
      case 429:
        this.errorKey.set('password.adminReset.error.rate');
        break;
      default:
        this.errorKey.set('password.adminReset.error.generic');
    }
  }

  /** True when the given control has the error AND has been interacted with (touched or dirty). */
  private fieldError(control: AbstractControl, error: string): boolean {
    return control.hasError(error) && (control.touched || control.dirty);
  }
}
