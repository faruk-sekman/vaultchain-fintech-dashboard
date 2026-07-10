/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Operator login screen: a reactive form that authenticates against the backend and,
 * on success, routes to `returnUrl` (or the dashboard). Standalone + OnPush; labels via ngx-translate
 * (TR/EN); errors are surfaced inline (generic — no user-enumeration).
 *
 * v2 §5 update: rendered as a two-pane SHOWCASE login. The branded value
 * panel (pulsing glyph + rotating welcome carousel over the brand gradient) and the top-right
 * lang/theme controls now live in the SHARED `AuthBrandPaneComponent` / `AuthHeaderControlsComponent`
 * (also used by the reset screen). This component keeps the auth form + three demo-role shortcuts that
 * prefill the form (no auto-submit, server stays the auth authority). Auth behaviour (validation,
 * 401/429 handling, returnUrl) is unchanged.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { HttpErrorResponse } from '@angular/common/http';
import { finalize } from 'rxjs/operators';
import { AuthService } from '@core/auth/auth.service';
import { AuthBrandPaneComponent } from '../../components/auth-brand-pane/auth-brand-pane.component';
import { AuthHeaderControlsComponent } from '../../components/auth-header-controls/auth-header-controls.component';

/**
 * Demo / showcase sign-in shortcut. Each entry maps to a dev SEED user
 * (`Api/scripts/seed-dev.ts`) and carries the documented, NON-SECRET local-dev password —
 * intentionally surfaced on the public showcase login so a visitor can try each role (the login
 * is a demo/showcase surface; all backing data is simulated). `roleKey` indexes the i18n role copy
 * under `auth.login.demo.roles.*`; `email`/`password` are non-translatable data, so they live here
 * rather than in the i18n bundles (which also keeps credentials out of the translation files).
 */
interface DemoAccount {
  readonly roleKey: 'administrator' | 'operator' | 'auditor';
  readonly email: string;
  readonly password: string;
  readonly icon: string;
  /** Fully-resolved i18n keys — kept on the data so the template references a property rather than
   *  ending a string literal right before `| translate` (which the i18n key-scanner misreads). */
  readonly nameKey: string;
  readonly descKey: string;
}

/**
 * The seed users' shared local-dev password (`DEFAULT_DEV_PASSWORD` in `seed-dev.ts`) — a
 * documented non-secret, never a real credential and only ever valid against the local dev DB.
 */
const DEMO_PASSWORD = 'Test-Passw0rd!';

@Component({
  selector: 'app-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    RouterLink,
    AuthBrandPaneComponent,
    AuthHeaderControlsComponent,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly submitting = signal(false);
  readonly errorKey = signal<string | null>(null);
  /** Interpolation params for `errorKey` (e.g. the `Retry-After` seconds on a 429 lockout). */
  readonly errorParams = signal<Record<string, unknown> | undefined>(undefined);
  /** Local view state for the password show/hide toggle (no auth-behavior change). */
  readonly showPassword = signal(false);
  /** Demo-card click-ripple state (the design's `vc-pulse`); holds the role key of the pulsing card. */
  readonly pulsingRole = signal<string | null>(null);
  /** Monotonic token so a repeat/cross-card click cancels the prior ripple's pending timers. */
  private pulseSeq = 0;

  /**
   * The three demo roles offered on the showcase login.
   * Order mirrors privilege (Administrator → Compliance Officer → Viewer). Clicking one prefills
   * the form via `useDemoAccount()`; it never auto-submits — the visitor presses "Sign in".
   */
  readonly demoAccounts: readonly DemoAccount[] = [
    {
      roleKey: 'administrator',
      email: 'admin@example.com',
      password: DEMO_PASSWORD,
      icon: 'ri-shield-star-line',
      nameKey: 'auth.login.demo.roles.administrator.name',
      descKey: 'auth.login.demo.roles.administrator.desc',
    },
    {
      roleKey: 'operator',
      email: 'operator@example.com',
      password: DEMO_PASSWORD,
      icon: 'ri-shield-check-line',
      nameKey: 'auth.login.demo.roles.operator.name',
      descKey: 'auth.login.demo.roles.operator.desc',
    },
    {
      roleKey: 'auditor',
      email: 'auditor@example.com',
      password: DEMO_PASSWORD,
      icon: 'ri-eye-line',
      nameKey: 'auth.login.demo.roles.auditor.name',
      descKey: 'auth.login.demo.roles.auditor.desc',
    },
  ];

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });

  togglePassword(): void {
    this.showPassword.update(shown => !shown);
  }

  /**
   * Prefill the form from a demo account so the visitor can review the credentials and submit
   * themselves — no auto sign-in (D2). Clears any prior error/lockout message so the card reads
   * clean. The form still validates on submit, so an edited/cleared field is handled normally.
   */
  useDemoAccount(account: DemoAccount): void {
    this.form.setValue({ email: account.email, password: account.password });
    this.form.markAsPristine();
    this.errorKey.set(null);
    this.errorParams.set(undefined);
    this.pulseCard(account.roleKey);
  }

  /**
   * Replays the click-ripple on a demo card (the design's `vc-pulse`). Drops the flag then re-adds it
   * next tick so the keyframe restarts on a repeat click, and clears it after the keyframe duration.
   * Timeout-based (not `animationend`) so it stays correct under reduced motion, and seq-guarded so a
   * newer click cancels older timers.
   */
  private pulseCard(role: string): void {
    const seq = ++this.pulseSeq;
    // Drop then re-add next tick so the keyframe replays even on a repeat click on the same card,
    // then clear after the keyframe duration so the flag never sticks.
    this.pulsingRole.set(null);
    setTimeout(() => {
      if (this.pulseSeq === seq) this.pulsingRole.set(role);
    });
    setTimeout(() => {
      if (this.pulseSeq === seq) this.pulsingRole.set(null);
    }, 660);
  }

  submit(): void {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.errorKey.set(null);
    this.errorParams.set(undefined);
    const { email, password } = this.form.getRawValue();

    this.auth
      .login(email, password)
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: result => {
          if (result.status === 'mfa_required') {
            // Password OK, second factor required → route to the challenge screen, carrying
            // any returnUrl so the post-verify landing is preserved. No session is granted yet.
            const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
            void this.router.navigate(['/mfa/verify'], {
              queryParams: returnUrl ? { returnUrl } : {},
            });
            return;
          }
          void this.router.navigateByUrl(this.safeReturnUrl());
        },
        error: (err: HttpErrorResponse) => {
          this.applyLoginError(err);
        },
      });
  }

  /**
   * Map the login failure to a localized message. 401 stays a generic "invalid" (no user
   * enumeration); a 429 rate-limit lockout shows a dedicated "too many attempts"
   * message and, when the backend sends a numeric `Retry-After` (seconds), surfaces the wait time.
   * Everything else falls back to the generic failure.
   */
  private applyLoginError(err: HttpErrorResponse): void {
    if (err.status === 401) {
      this.errorKey.set('auth.login.invalid');
      return;
    }
    if (err.status === 429) {
      const seconds = this.parseRetryAfter(err.headers?.get('Retry-After'));
      if (seconds !== null) {
        this.errorKey.set('auth.login.lockedRetry');
        this.errorParams.set({ seconds });
      } else {
        this.errorKey.set('auth.login.locked');
      }
      return;
    }
    this.errorKey.set('auth.login.failed');
  }

  /** Parse a `Retry-After` header value of delta-seconds into a positive integer, else null. */
  private parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value.trim());
    if (!Number.isInteger(seconds) || seconds <= 0) return null;
    return seconds;
  }

  private safeReturnUrl(): string {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    if (!returnUrl) return '/dashboard';
    if (!returnUrl.startsWith('/') || returnUrl.startsWith('//') || returnUrl.includes('\\')) {
      return '/dashboard';
    }
    return returnUrl;
  }
}
