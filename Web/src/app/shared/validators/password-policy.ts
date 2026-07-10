/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared password policy for the reset flows. One source of truth used by
 * both the live `app-password-rules` card and the reactive-form `passwordPolicyValidator`, so what the
 * user sees turning green is exactly what the validator enforces.
 *
 * Lives in `@shared/validators` (re-audit ARCH-002) because it is reused ACROSS features — the auth
 * reset wizard (`forgot-password` + `password-rules`) and the settings `admin-password-reset` — rather
 * than inside one feature. The login form has its own inline `minLength(8)`, so this is not used by
 * login. The minimum length is 12 to match the backend self-service reset policy (`Auth.WeakPassword`
 * is returned for a 9–11 char password), so the on-screen meter never passes a password the server 400s.
 */
import { AbstractControl, ValidationErrors } from '@angular/forms';

/** Minimum new-password length — kept in lock-step with the backend reset policy (min 12). */
export const PASSWORD_MIN = 12;

export interface PasswordRule {
  readonly key: string;
  /** i18n key for the rule label. */
  readonly labelKey: string;
  readonly test: (password: string) => boolean;
}

/** All rules are required. Order matches the design's two-column list. */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  { key: 'len', labelKey: 'auth.forgot.rules.len', test: pw => pw.length >= PASSWORD_MIN },
  { key: 'upper', labelKey: 'auth.forgot.rules.upper', test: pw => /[A-Z]/.test(pw) },
  { key: 'lower', labelKey: 'auth.forgot.rules.lower', test: pw => /[a-z]/.test(pw) },
  { key: 'digit', labelKey: 'auth.forgot.rules.digit', test: pw => /[0-9]/.test(pw) },
  { key: 'symbol', labelKey: 'auth.forgot.rules.symbol', test: pw => /[^A-Za-z0-9]/.test(pw) },
];

/** Hard cap (also enforced via `maxlength` on the input). */
export const PASSWORD_MAX = 64;

/** i18n keys for the 4 strength levels (index 1..4; 0 = empty/no label). */
export const STRENGTH_LABEL_KEYS = [
  '',
  'auth.forgot.strength.weak',
  'auth.forgot.strength.fair',
  'auth.forgot.strength.strong',
  'auth.forgot.strength.veryStrong',
] as const;

export interface PasswordEvaluation {
  readonly results: ReadonlyArray<PasswordRule & { met: boolean }>;
  readonly met: number;
  /** 0 (empty) → 4 (very strong). */
  readonly score: number;
  /** True when every rule passes and length is within the cap. */
  readonly allMet: boolean;
}

/** Evaluate a password against the policy: per-rule results, count, strength score, overall pass. */
export function evaluatePassword(password: string): PasswordEvaluation {
  const pw = password ?? '';
  const results = PASSWORD_RULES.map(rule => ({ ...rule, met: rule.test(pw) }));
  const met = results.filter(r => r.met).length;
  const score = pw.length === 0 ? 0 : met <= 2 ? 1 : met === 3 ? 2 : met === 4 ? 3 : 4;
  const allMet = met === PASSWORD_RULES.length && pw.length <= PASSWORD_MAX;
  return { results, met, score, allMet };
}

/** Reactive-form validator mirroring the policy (empty → required, otherwise policy pass/fail). */
export function passwordPolicyValidator(control: AbstractControl): ValidationErrors | null {
  const pw = (control.value ?? '') as string;
  if (!pw) return { required: true };
  return evaluatePassword(pw).allMet ? null : { policy: true };
}

/** Group-level validator: the confirmation must equal the new password (only once both are set). */
export function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirm = group.get('confirm')?.value;
  return password && confirm && password !== confirm ? { mismatch: true } : null;
}
