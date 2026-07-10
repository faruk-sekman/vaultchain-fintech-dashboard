/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Live password requirements card for the reset flow's password step. Shown from the
 * start: a 4-segment strength meter + label, then the five policy rules that turn green (with a pop)
 * as they are satisfied. Pure presentation — it reads `password` and renders; the form enforces the
 * same policy via `passwordPolicyValidator`. Styling reuses `--ld-*` inherited from `.forgot`.
 */
import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { STRENGTH_LABEL_KEYS, evaluatePassword } from '@shared/validators/password-policy';

@Component({
  selector: 'app-password-rules',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslateModule],
  templateUrl: './password-rules.component.html',
  styleUrl: './password-rules.component.scss',
})
export class PasswordRulesComponent {
  @Input({ required: true })
  set password(value: string) {
    this.pw.set(value ?? '');
  }

  private readonly pw = signal('');
  protected readonly segments = [1, 2, 3, 4];
  private readonly strengthColors = ['#dc2b32', '#e08a1e', '#1f9d54', '#16864a'];

  protected readonly evaluation = computed(() => evaluatePassword(this.pw()));
  protected readonly labelKey = computed(() => STRENGTH_LABEL_KEYS[this.evaluation().score]);
  protected readonly color = computed(() => {
    const score = this.evaluation().score;
    return score > 0 ? this.strengthColors[score - 1] : 'var(--ld-faint)';
  });
}
