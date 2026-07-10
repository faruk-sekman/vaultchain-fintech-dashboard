/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the administrator password-reset screen. Covers: the operator-list load (and
 * its 403/empty fallback to the manual UUID field), the new-password policy gating the submit, UUID
 * validation gating the submit, the destructive confirm opening before any call, confirm posting EXACTLY
 * the trimmed targetUserId + the new password, the HTTP-status → inline-message mapping (403 self-reset /
 * 404 unknown / 400 weak / 429 rate / generic), and the success → "reset another" reset. The
 * SILENT_REQUEST contract is asserted at the PasswordResetApi layer (password-reset.api.spec).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { NEVER, of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { RbacApi, RbacUser } from '@core/api/rbac.api';
import { AdminPasswordResetComponent } from './admin-password-reset.component';
import { AdminResetRequestsComponent } from '../../components/admin-reset-requests/admin-reset-requests.component';
import pageTemplate from './admin-password-reset.component.html?raw';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const STRONG_PASSWORD = 'Aa1!aaaaaaaa'; // 12 chars: upper + lower + digit + symbol → passes the policy.

const SEED_USERS: RbacUser[] = [
  {
    id: VALID_UUID,
    displayName: 'Ops Operator',
    status: 'active',
    roles: ['operator'],
    emailMasked: 'o***@s***.local',
    locked: true,
    failedLoginCount: 5,
    lastLoginAt: '2026-06-20T08:00:00.000Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    displayName: 'Audit Auditor',
    status: 'active',
    roles: ['auditor'],
    emailMasked: 'a***@s***.local',
    locked: false,
    failedLoginCount: 0,
    lastLoginAt: null,
  },
];

function setup(options: { users?: ReturnType<typeof of>; usersError?: unknown } = {}) {
  const auth = {
    adminResetPassword: vi.fn().mockReturnValue(of(undefined)),
  };
  const rbac = {
    listUsers: vi
      .fn()
      .mockReturnValue(
        options.usersError !== undefined
          ? throwError(() => options.usersError)
          : (options.users ?? of(SEED_USERS)),
      ),
  };
  const i18n = { instant: (k: string) => k };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: RbacApi, useValue: rbac },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new AdminPasswordResetComponent());
  return { component, auth, rbac };
}

function httpError(status: number): HttpErrorResponse {
  return new HttpErrorResponse({ status });
}

/** Fill a valid form (target id + strong password) so only the behaviour under test varies. */
function fillValid(component: AdminPasswordResetComponent): void {
  component.form.controls.targetUserId.setValue(VALID_UUID);
  component.form.controls.newPassword.setValue(STRONG_PASSWORD);
}

describe('AdminPasswordResetComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('embeds the reset-requests review section at the BOTTOM of the page (EK-2, one recovery surface)', () => {
    // Structural pin on the raw template (the direct-instantiation tests never compile it): the
    // embedded section renders AFTER the password-reset card, inside the same page shell.
    const embedAt = pageTemplate.indexOf('<app-admin-reset-requests');
    expect(embedAt).toBeGreaterThan(pageTemplate.lastIndexOf('</app-ui-card>'));
    // And the component's imports actually carry the embedded standalone component (identity
    // check on the compiled dependency list — a dropped import would otherwise only fail the build).
    const compiled = (AdminPasswordResetComponent as unknown as Record<string, unknown>)[
      'ɵcmp'
    ] as {
      dependencies?: unknown[] | (() => unknown[]);
    };
    const deps =
      typeof compiled.dependencies === 'function'
        ? compiled.dependencies()
        : (compiled.dependencies ?? []);
    expect(deps).toContain(AdminResetRequestsComponent);
  });

  it('starts idle: no success, no error, empty form, and loads the operator roster', () => {
    const { component, rbac } = setup();
    expect(component.succeeded()).toBe(false);
    expect(component.errorKey()).toBeNull();
    expect(component.confirmOpen()).toBe(false);
    expect(component.form.controls.targetUserId.value).toBe('');
    expect(component.form.controls.newPassword.value).toBe('');
    expect(rbac.listUsers).toHaveBeenCalledTimes(1);
    expect(component.users().length).toBe(2);
    expect(component.usersFallback()).toBe(false);
  });

  it('selecting an operator from the dropdown writes its id into the same targetUserId control', () => {
    // The custom disclosure dropdown (v2 reference) drives the SAME control the manual field uses:
    // selectUser writes the chosen id, marks it touched/dirty, and closes the listbox.
    const { component } = setup();
    component.togglePicker();
    expect(component.pickerOpen()).toBe(true);

    component.selectUser(SEED_USERS[0]);
    expect(component.form.controls.targetUserId.value).toBe(VALID_UUID);
    expect(component.form.controls.targetUserId.touched).toBe(true);
    expect(component.pickerOpen()).toBe(false);
    // selectedUser() resolves the chosen operator from the roster for the closed-state presentation.
    expect(component.selectedUser()?.id).toBe(VALID_UUID);
  });

  it('the closed control shows masked, PII-minimal initials + name (no fabricated email / lock pill)', () => {
    const { component } = setup();
    // Initials mirror app-ui-avatar; the name is lightly masked; no email field exists on the roster.
    expect(component.initialsFor('Ops Operator')).toBe('OO');
    expect(component.maskName('Ops Operator')).toBe('O** O***');
    expect(component.maskName('Mert')).toBe('M***');
  });

  it('keeps presentation helpers safe for nullish picker values', () => {
    const { component } = setup();
    expect(component.initialsFor(null as unknown as string)).toBe('');
    expect(component.maskName(null as unknown as string)).toBe('');
  });

  it('mirrors a nullish password control value as an empty strength input', () => {
    const { component } = setup();
    component.form.controls.newPassword.setValue(null as unknown as string);
    expect(component.passwordValue()).toBe('');
  });

  it('lastLoginTime buckets a recent ISO into the shared relative-time key (days ago)', () => {
    // Mirrors the notifications feed: the helper returns a static i18n key + params (not absolute) for a
    // sub-7-day timestamp, so "Last sign-in" renders e.g. "2 days ago" from the real lastLoginAt value.
    const { component } = setup();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = component.lastLoginTime(twoDaysAgo);
    expect(result.absolute).toBe(false);
    expect(result.key).toBe('common.time.daysAgo');
    expect(result.params).toEqual({ count: 2 });
  });

  it('lastLoginTime flags an old ISO (>= 7 days) as absolute so the template renders a date', () => {
    const { component } = setup();
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(component.lastLoginTime(longAgo).absolute).toBe(true);
  });

  it('Escape closes the dropdown when open and is a no-op when closed', () => {
    const { component } = setup();
    component.onEscape();
    expect(component.pickerOpen()).toBe(false);
    component.togglePicker();
    component.onEscape();
    expect(component.pickerOpen()).toBe(false);
  });

  it('the picker control binding sets the target id (the value the dropdown writes back)', () => {
    const { component } = setup();
    component.form.controls.targetUserId.setValue(VALID_UUID);
    expect(component.form.controls.targetUserId.value).toBe(VALID_UUID);
  });

  it('an EMPTY operator list flips to the manual-UUID fallback', () => {
    const { component } = setup({ users: of([] as RbacUser[]) });
    expect(component.usersFallback()).toBe(true);
  });

  it('a 403 on the operator list flips to the manual-UUID fallback (no users.manage)', () => {
    const { component } = setup({ usersError: httpError(403) });
    expect(component.usersFallback()).toBe(true);
    expect(component.users().length).toBe(0);
  });

  it('does NOT open the confirm dialog for an empty target id (required)', () => {
    const { component } = setup();
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    component.askReset();
    expect(component.confirmOpen()).toBe(false);
    expect(component.showUserRequired()).toBe(true);
  });

  it('does NOT open the confirm dialog for a non-UUID target id (pattern)', () => {
    const { component } = setup();
    component.form.controls.targetUserId.setValue('not-a-uuid');
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    component.askReset();
    expect(component.confirmOpen()).toBe(false);
    expect(component.showUserUuid()).toBe(true);
  });

  it('shows the UUID error for dirty invalid input even before blur', () => {
    const { component } = setup();
    component.form.controls.targetUserId.setValue('not-a-uuid');
    component.form.controls.targetUserId.markAsDirty();
    expect(component.showUserUuid()).toBe(true);
  });

  it('does NOT open the confirm dialog for a weak password (policy)', () => {
    const { component } = setup();
    component.form.controls.targetUserId.setValue(VALID_UUID);
    component.form.controls.newPassword.setValue('weak'); // too short, no upper/digit/symbol
    component.askReset();
    expect(component.confirmOpen()).toBe(false);
    expect(component.showPasswordPolicy()).toBe(true);
    expect(component['auth'].adminResetPassword).not.toHaveBeenCalled();
  });

  it('a valid target + strong password opens the destructive confirm dialog and makes NO call yet', () => {
    const { component, auth } = setup();
    fillValid(component);
    component.askReset();
    expect(component.confirmOpen()).toBe(true);
    expect(auth.adminResetPassword).not.toHaveBeenCalled();
  });

  it('confirm calls the service with EXACTLY the trimmed { targetUserId, newPassword } and closes the dialog', () => {
    const { component, auth } = setup();
    component.form.controls.targetUserId.setValue(`  ${VALID_UUID}  `);
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    component.confirmReset();
    expect(auth.adminResetPassword).toHaveBeenCalledWith(VALID_UUID, STRONG_PASSWORD);
    expect(component.confirmOpen()).toBe(false);
  });

  it('cancel from the confirm dialog makes no call', () => {
    const { component, auth } = setup();
    fillValid(component);
    component.askReset();
    component.cancelReset();
    expect(component.confirmOpen()).toBe(false);
    expect(auth.adminResetPassword).not.toHaveBeenCalled();
  });

  it('success → shows the success state, clears the password, and stops submitting', () => {
    const { component } = setup();
    fillValid(component);
    component.confirmReset();
    expect(component.succeeded()).toBe(true);
    expect(component.submitting()).toBe(false);
    expect(component.errorKey()).toBeNull();
    // The entered password is dropped from the form the instant the reset lands (no lingering secret).
    expect(component.form.controls.newPassword.value).toBe('');
  });

  it('self-reset 403 → the specific selfReset inline message (no success)', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(throwError(() => httpError(403)));
    fillValid(component);
    component.confirmReset();
    expect(component.errorKey()).toBe('password.adminReset.error.selfReset');
    expect(component.succeeded()).toBe(false);
    expect(component.submitting()).toBe(false);
  });

  it('unknown user 404 → the unknown inline message', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(throwError(() => httpError(404)));
    fillValid(component);
    component.confirmReset();
    expect(component.errorKey()).toBe('password.adminReset.error.unknown');
  });

  it('weak/same 400 → the weak inline message', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(throwError(() => httpError(400)));
    fillValid(component);
    component.confirmReset();
    expect(component.errorKey()).toBe('password.adminReset.error.weak');
  });

  it('rate-limit 429 → the rate inline message', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(throwError(() => httpError(429)));
    fillValid(component);
    component.confirmReset();
    expect(component.errorKey()).toBe('password.adminReset.error.rate');
  });

  it('an unmapped failure (500 / network) → the generic inline message', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(throwError(() => httpError(500)));
    fillValid(component);
    component.confirmReset();
    expect(component.errorKey()).toBe('password.adminReset.error.generic');
  });

  it('"reset another" clears the success state, the form, and any error', () => {
    const { component } = setup();
    fillValid(component);
    component.confirmReset();
    expect(component.succeeded()).toBe(true);

    component.resetAnother();
    expect(component.succeeded()).toBe(false);
    expect(component.errorKey()).toBeNull();
    expect(component.form.controls.targetUserId.value).toBe('');
    expect(component.form.controls.newPassword.value).toBe('');
    expect(component.passwordValue()).toBe('');
  });

  it('confirmReset is a no-op while a request is already in flight (guards double-submit)', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(NEVER);
    fillValid(component);
    component.confirmReset();
    expect(component.submitting()).toBe(true);

    component.confirmReset();
    expect(auth.adminResetPassword).toHaveBeenCalledTimes(1);
  });

  it('askReset is a no-op while a request is in flight (guards re-opening the confirm dialog)', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(NEVER);
    fillValid(component);
    component.confirmReset();
    expect(component.submitting()).toBe(true);
    expect(component.confirmOpen()).toBe(false);

    component.askReset();
    expect(component.confirmOpen()).toBe(false);
  });

  it('the password live-mirror tracks the control for the OnPush strength card', () => {
    const { component } = setup();
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    expect(component.passwordValue()).toBe(STRONG_PASSWORD);
  });

  it('the UUID validator tolerates a non-string control value without flagging a pattern error', () => {
    const { component } = setup();
    component.form.controls.targetUserId.setValue(null as unknown as string);
    expect(component.form.controls.targetUserId.hasError('pattern')).toBe(false);
    expect(component.form.controls.targetUserId.hasError('required')).toBe(true);
  });

  it('selectedUser resolves the chosen operator from the roster (and is null for an unknown id)', () => {
    const { component } = setup();
    // A manual paste of a known id resolves to its roster row for the closed-state presentation.
    component.form.controls.targetUserId.setValue(VALID_UUID);
    expect(component.selectedUser()?.displayName).toBe('Ops Operator');
    // An id not in the roster resolves to null (the closed control then shows its placeholder).
    component.form.controls.targetUserId.setValue('99999999-9999-9999-9999-999999999999');
    expect(component.selectedUser()).toBeNull();
  });

  it('the live evaluation + strength label track the entered password (OnPush strength card source)', () => {
    const { component } = setup();
    // Empty → score 0 and the empty-string label key.
    expect(component.evaluation().score).toBe(0);
    expect(component.strengthLabelKey()).toBe('');
    // A strong password lifts the score and yields a non-empty strength label key.
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    expect(component.evaluation().score).toBeGreaterThan(0);
    expect(component.strengthLabelKey().length).toBeGreaterThan(0);
    // The four meter segments are fixed 1..4.
    expect(component.strengthSegments).toEqual([1, 2, 3, 4]);
  });

  it('showPasswordPolicy reflects required (empty+touched) then policy (weak+touched)', () => {
    const { component } = setup();
    // Untouched empty → no message yet.
    expect(component.showPasswordPolicy()).toBe(false);
    // Touched + empty → the required branch shows the message.
    component.form.controls.newPassword.markAsTouched();
    expect(component.showPasswordPolicy()).toBe(true);
    // Touched + weak (non-empty but fails policy) → the policy branch shows the message.
    component.form.controls.newPassword.setValue('weak');
    expect(component.showPasswordPolicy()).toBe(true);
    // A strong password clears it.
    component.form.controls.newPassword.setValue(STRONG_PASSWORD);
    expect(component.showPasswordPolicy()).toBe(false);
  });

  it('showPasswordPolicy reflects the maxlength branch for an over-long value', () => {
    const { component } = setup();
    component.form.controls.newPassword.markAsTouched();
    // 65 chars → exceeds PASSWORD_MAX (64), tripping the maxlength validator branch.
    component.form.controls.newPassword.setValue(`Aa1!${'a'.repeat(61)}`);
    expect(component.form.controls.newPassword.hasError('maxlength')).toBe(true);
    expect(component.showPasswordPolicy()).toBe(true);
  });

  it('toggleShow flips the temporary-password reveal', () => {
    const { component } = setup();
    expect(component.showPassword()).toBe(false);
    component.toggleShow();
    expect(component.showPassword()).toBe(true);
    component.toggleShow();
    expect(component.showPassword()).toBe(false);
  });

  it('initialsFor derives up to two uppercase initials (single, multi, and empty names)', () => {
    const { component } = setup();
    expect(component.initialsFor('Ops Operator')).toBe('OO');
    expect(component.initialsFor('Mert')).toBe('M'); // single word → one initial
    expect(component.initialsFor('  ada   grace  hopper ')).toBe('AH'); // first + last word
    expect(component.initialsFor('')).toBe(''); // empty → empty
  });

  it('maskName keeps each word’s first letter and masks the rest (single-letter words pass through)', () => {
    const { component } = setup();
    expect(component.maskName('Ops Operator')).toBe('O** O***');
    expect(component.maskName('Mert')).toBe('M***');
    // The mask is capped at 3 stars regardless of word length.
    expect(component.maskName('Verylongname')).toBe('V***');
    // A single-letter word is passed through unchanged (no star).
    expect(component.maskName('A team')).toBe('A t***');
    expect(component.maskName('')).toBe('');
  });

  it('generatePassword fills a policy-passing temp password, reveals it, and updates the live meter', () => {
    const { component } = setup();
    component.generatePassword();

    const generated = component.form.controls.newPassword.value;
    expect(generated).toHaveLength(16);
    // It always satisfies every policy class, so the validator passes and the field is dirty/touched.
    expect(component.form.controls.newPassword.hasError('policy')).toBe(false);
    expect(component.form.controls.newPassword.valid).toBe(true);
    expect(component.form.controls.newPassword.dirty).toBe(true);
    expect(component.form.controls.newPassword.touched).toBe(true);
    // Revealed + mirrored into the live-evaluation signal.
    expect(component.showPassword()).toBe(true);
    expect(component.passwordValue()).toBe(generated);
    expect(component.evaluation().allMet).toBe(true);
    // Every required character class is present (upper/lower/digit/symbol).
    expect(/[A-Z]/.test(generated)).toBe(true);
    expect(/[a-z]/.test(generated)).toBe(true);
    expect(/[0-9]/.test(generated)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(generated)).toBe(true);
  });

  it('generatePassword produces a fresh value each call (CSPRNG, not a constant)', () => {
    const { component } = setup();
    component.generatePassword();
    const first = component.form.controls.newPassword.value;
    component.generatePassword();
    const second = component.form.controls.newPassword.value;
    // Astronomically unlikely to collide with a real CSPRNG; guards against a constant/tautology.
    expect(second).not.toBe(first);
  });

  it('generatePassword is a no-op while a reset is in flight (guards clobbering the submitted value)', () => {
    const { component, auth } = setup();
    auth.adminResetPassword.mockReturnValueOnce(NEVER);
    fillValid(component);
    component.confirmReset();
    expect(component.submitting()).toBe(true);
    const inFlightValue = component.form.controls.newPassword.value;

    component.generatePassword();
    expect(component.form.controls.newPassword.value).toBe(inFlightValue); // unchanged
  });

  it('generatePassword still yields a valid password when the Web Crypto API is unavailable (Math.random fallback)', () => {
    // Force the `webCrypto?.getRandomValues` guard down its Math.random fallback branch.
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      const { component } = setup();
      component.generatePassword();
      const generated = component.form.controls.newPassword.value;
      expect(generated).toHaveLength(16);
      expect(component.form.controls.newPassword.valid).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
