/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA enrolment wizard (relocated into the Settings drawer).
 * Three accessible steps:
 *   1. password   — re-authenticate; `mfaSetupStart` returns the otpauth QR (data-URL) + manual key.
 *   2. confirm     — scan the QR / enter the manual key, then confirm a current code; `mfaSetupConfirm`
 *                    activates MFA and returns the one-time backup codes.
 *   3. backup      — show the backup codes EXACTLY ONCE with copy + download, gated behind an explicit
 *                    "I saved these" confirmation before "Done".
 *
 * This component is now hosted as the CONTENT of the Settings `app-ui-drawer` rather than a
 * detached full page. It no longer navigates on finish/cancel — it raises {@link done}/{@link cancelled}
 * and the Settings shell owns closing the drawer + returning to Settings › Security. Secret clearing is
 * LIFECYCLE-bound (`ngOnDestroy`) so closing the drawer (which destroys this instance under `@if (open)`)
 * GCs the transient QR/backup signals even on a path that skips the buttons.
 *
 * Standalone + OnPush + signals + reactive forms. The QR data-URL and the backup codes are held only
 * in transient signals (cleared on leave AND on destroy); no secret is ever logged or persisted.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  OnDestroy,
  Output,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import { AuthService } from '@core/auth/auth.service';
import { ToastService } from '@core/services/toast.service';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';

type WizardStep = 'password' | 'confirm' | 'backup';

@Component({
  selector: 'app-mfa-setup-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiAlertComponent,
    UiButtonComponent,
  ],
  templateUrl: './mfa-setup-wizard.component.html',
  styleUrl: './mfa-setup-wizard.component.scss',
})
export class MfaSetupWizardComponent implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(TranslateService);
  private readonly toast = inject(ToastService);

  /** Enrolment completed (codes saved): the Settings shell closes the drawer + returns to Security. */
  @Output() readonly done = new EventEmitter<void>();
  /** Enrolment abandoned (Cancel/Esc/scrim/close): the shell closes the drawer + returns to Security. */
  @Output() readonly cancelled = new EventEmitter<void>();
  /**
   * Mirrors {@link dismissBlocked} to the host so it can drive the drawer's `[disableClose]` (security
   * req B) without the host reaching into a `#ref` declared inside the drawer's own `@if (open)` block
   * (which is out of template scope). The host stores this in its OWN signal — no shared wizard state.
   */
  @Output() readonly dismissBlockedChange = new EventEmitter<boolean>();

  /** The ordered steps, exposed for the step indicator (`aria-current` on the active one). */
  readonly steps: readonly WizardStep[] = ['password', 'confirm', 'backup'];
  readonly step = signal<WizardStep>('password');

  readonly submitting = signal(false);
  readonly errorKey = signal<string | null>(null);

  /** otpauth provisioning data (transient — held only while the confirm step is on screen). */
  readonly qrDataUrl = signal<string | null>(null);
  readonly otpauthUri = signal<string | null>(null);
  /** The one-time backup codes, shown ONCE; cleared when the wizard finishes/leaves. */
  readonly backupCodes = signal<readonly string[]>([]);
  /** The explicit "I saved these" gate that unlocks "Done". */
  readonly savedConfirmed = signal(false);

  /**
   * Whether the hosting drawer must refuse Esc/scrim dismissal (security req B). True ONLY
   * while the one-time backup codes are on screen and not yet acknowledged — a stray Esc/scrim must not
   * discard the codes before "I have saved these" is ticked. Earlier steps stay freely cancellable.
   */
  readonly dismissBlocked = computed(() => this.step() === 'backup' && !this.savedConfirmed());

  readonly passwordForm = this.fb.nonNullable.group({
    password: ['', [Validators.required]],
  });
  readonly confirmForm = this.fb.nonNullable.group({
    code: ['', [Validators.required, Validators.pattern(/^\d{6}$/)]],
  });

  readonly errorId = 'mfa-setup-error';

  /** The backup-step heading, focused on entry so focus never drops to <body> when the close-X is removed. */
  private readonly backupHeading = viewChild<ElementRef<HTMLElement>>('backupHeading');

  constructor() {
    // Push every dismiss-block transition (step → backup, savedConfirmed toggled) to the host so the
    // drawer's `[disableClose]` stays in lock-step. Reactive + OnPush-safe; emits the initial value too.
    effect(() => this.dismissBlockedChange.emit(this.dismissBlocked()));
    // a11y: when the backup step mounts, pull focus to its heading so it never drops to <body> during
    // the confirm→backup transition (the close-X is removed once dismissal is blocked, security req B).
    effect(() => {
      if (this.step() === 'backup') this.backupHeading()?.nativeElement.focus();
    });
  }

  /** 1-based index of the active step for the indicator copy. */
  stepIndex(): number {
    return this.steps.indexOf(this.step()) + 1;
  }

  // --- Step 1: password → start ------------------------------------------------
  startSetup(): void {
    if (this.submitting() || this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorKey.set(null);
    this.auth
      .mfaSetupStart(this.passwordForm.getRawValue().password)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: data => {
          this.qrDataUrl.set(data.qrDataUrl);
          this.otpauthUri.set(data.otpauthUri);
          this.step.set('confirm');
        },
        error: () => this.errorKey.set('mfa.setup.startError'),
      });
  }

  // --- Step 2: confirm code → activate -----------------------------------------
  confirmSetup(): void {
    if (this.submitting() || this.confirmForm.invalid) {
      this.confirmForm.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorKey.set(null);
    this.auth
      .mfaSetupConfirm(this.confirmForm.getRawValue().code)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: data => {
          this.backupCodes.set(data.backupCodes);
          // The secret is now consumed server-side; drop the provisioning data from memory.
          this.qrDataUrl.set(null);
          this.otpauthUri.set(null);
          this.step.set('backup');
        },
        error: () => this.errorKey.set('mfa.setup.confirmError'),
      });
  }

  // --- Step 3: backup codes ----------------------------------------------------
  toggleSaved(): void {
    this.savedConfirmed.update(v => !v);
  }

  copyCodes(): void {
    const text = this.backupCodes().join('\n');
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav?.clipboard?.writeText) {
      nav.clipboard
        .writeText(text)
        .then(() => this.toast.success(this.i18n.instant('mfa.setup.copied')))
        .catch(() => this.toast.error(this.i18n.instant('mfa.setup.copyFailed')));
    } else {
      this.toast.error(this.i18n.instant('mfa.setup.copyFailed'));
    }
  }

  downloadCodes(): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      return;
    }
    const blob = new Blob([this.backupCodes().join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mfa-backup-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Finish: clear the transient secrets and signal the Settings shell to close the drawer + return to
   * Settings › Security. Gated behind the explicit "I saved these" confirmation.
   */
  finish(): void {
    if (!this.savedConfirmed()) return;
    this.backupCodes.set([]);
    this.done.emit();
  }

  /**
   * Abandon enrolment (Cancel button, or the drawer's Esc/scrim/close on earlier steps). Clears every
   * transient secret and signals the Settings shell to close the drawer + return to Settings › Security.
   * MFA-enabled state is untouched here (it only flips server-side once `mfaSetupConfirm` succeeds).
   */
  cancel(): void {
    this.clearSecrets();
    this.cancelled.emit();
  }

  /**
   * Lifecycle-bound secret clear (security req A): whenever this instance is destroyed —
   * including when the drawer closes under `@if (open)` on ANY path — null the transient provisioning
   * data + backup codes so they cannot linger in memory beyond the wizard's life.
   */
  ngOnDestroy(): void {
    this.clearSecrets();
  }

  /** Null every transient secret + reset the saved-gate. Never logs the values. */
  private clearSecrets(): void {
    this.qrDataUrl.set(null);
    this.otpauthUri.set(null);
    this.backupCodes.set([]);
    this.savedConfirmed.set(false);
  }
}
