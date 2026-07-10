/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the administrator MFA-reset screen. Covers: UUID validation gates the submit,
 * the destructive confirm opens before any call, confirm posts EXACTLY the target userId, the HTTP-status
 * → inline-message mapping (403 self-reset / 404 + 400 invalid-target / 429 rate-limit / generic), and the
 * success → "reset another" reset. The SILENT_REQUEST contract is asserted at the MfaApi layer (mfa.api.spec).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { NEVER, of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { AdminMfaResetComponent } from './admin-mfa-reset.component';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

function setup() {
  const auth = {
    mfaAdminReset: vi.fn().mockReturnValue(of(undefined)),
  };
  const router = { navigate: vi.fn() };
  const i18n = { instant: (k: string) => k };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new AdminMfaResetComponent());
  return { component, auth, router };
}

function httpError(status: number): HttpErrorResponse {
  return new HttpErrorResponse({ status });
}

describe('AdminMfaResetComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts idle: no success, no error, empty form', () => {
    const { component } = setup();
    expect(component.succeeded()).toBe(false);
    expect(component.errorKey()).toBeNull();
    expect(component.confirmOpen()).toBe(false);
    expect(component.form.controls.userId.value).toBe('');
  });

  it('renders the standard Settings › Security › reset breadcrumb trail', () => {
    const { component } = setup();
    expect(component.breadcrumbItems).toEqual([
      { labelKey: 'nav.settings', link: '/settings' },
      { labelKey: 'settings.sections.security' },
      { labelKey: 'mfa.adminReset.pageTitle' },
    ]);
  });

  it('does NOT open the confirm dialog for an empty user id (required) — surfaces the field error', () => {
    const { component } = setup();
    component.askReset();
    expect(component.confirmOpen()).toBe(false);
    expect(component.showRequired()).toBe(true);
  });

  it('does NOT open the confirm dialog for a non-UUID user id (pattern)', () => {
    const { component } = setup();
    component.form.controls.userId.setValue('not-a-uuid');
    component.askReset();
    expect(component.confirmOpen()).toBe(false);
    expect(component.showUuid()).toBe(true);
  });

  it('a valid UUID opens the destructive confirm dialog and makes NO call yet', () => {
    const { component, auth } = setup();
    component.form.controls.userId.setValue(VALID_UUID);
    component.askReset();
    expect(component.confirmOpen()).toBe(true);
    expect(auth.mfaAdminReset).not.toHaveBeenCalled();
  });

  it('confirm calls the service with EXACTLY the trimmed { userId } and closes the dialog', () => {
    const { component, auth } = setup();
    component.form.controls.userId.setValue(`  ${VALID_UUID}  `);
    component.confirmReset();
    expect(auth.mfaAdminReset).toHaveBeenCalledWith(VALID_UUID);
    expect(component.confirmOpen()).toBe(false);
  });

  it('cancel from the confirm dialog makes no call', () => {
    const { component, auth } = setup();
    component.form.controls.userId.setValue(VALID_UUID);
    component.askReset();
    component.cancelReset();
    expect(component.confirmOpen()).toBe(false);
    expect(auth.mfaAdminReset).not.toHaveBeenCalled();
  });

  it('success → shows the success state and stops submitting', () => {
    const { component } = setup();
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.succeeded()).toBe(true);
    expect(component.submitting()).toBe(false);
    expect(component.errorKey()).toBeNull();
  });

  it('self-reset 403 → the specific selfReset inline message (no success)', () => {
    const { component, auth } = setup();
    auth.mfaAdminReset.mockReturnValueOnce(throwError(() => httpError(403)));
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.errorKey()).toBe('mfa.adminReset.error.selfReset');
    expect(component.succeeded()).toBe(false);
    expect(component.submitting()).toBe(false);
  });

  it('unknown user 404 → the invalidTarget inline message', () => {
    const { component, auth } = setup();
    auth.mfaAdminReset.mockReturnValueOnce(throwError(() => httpError(404)));
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.errorKey()).toBe('mfa.adminReset.error.invalidTarget');
  });

  it('validation 400 → the invalidTarget inline message', () => {
    const { component, auth } = setup();
    auth.mfaAdminReset.mockReturnValueOnce(throwError(() => httpError(400)));
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.errorKey()).toBe('mfa.adminReset.error.invalidTarget');
  });

  it('rate-limit 429 → the rateLimit inline message', () => {
    const { component, auth } = setup();
    auth.mfaAdminReset.mockReturnValueOnce(throwError(() => httpError(429)));
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.errorKey()).toBe('mfa.adminReset.error.rateLimit');
  });

  it('an unmapped failure (500 / network) → the generic inline message', () => {
    const { component, auth } = setup();
    auth.mfaAdminReset.mockReturnValueOnce(throwError(() => httpError(500)));
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.errorKey()).toBe('mfa.adminReset.error.generic');
  });

  it('"reset another" clears the success state, the form, and any error', () => {
    const { component } = setup();
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.succeeded()).toBe(true);

    component.resetAnother();
    expect(component.succeeded()).toBe(false);
    expect(component.errorKey()).toBeNull();
    expect(component.form.controls.userId.value).toBe('');
    expect(component.form.controls.userId.touched).toBe(false);
  });

  it('backToSecurity returns to the Settings security section', () => {
    const { component, router } = setup();
    component.backToSecurity();
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'security' },
    });
  });

  it('confirmReset is a no-op while a request is already in flight (guards double-submit)', () => {
    const { component, auth } = setup();
    // A pending observable that never emits keeps `submitting` true.
    auth.mfaAdminReset.mockReturnValueOnce(NEVER);
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.submitting()).toBe(true);

    component.confirmReset();
    // Still only the first call.
    expect(auth.mfaAdminReset).toHaveBeenCalledTimes(1);
  });

  it('askReset is a no-op while a request is in flight (guards re-opening the confirm dialog)', () => {
    const { component, auth } = setup();
    // A pending request keeps `submitting()` true, so askReset must bail before re-opening the dialog.
    auth.mfaAdminReset.mockReturnValueOnce(NEVER);
    component.form.controls.userId.setValue(VALID_UUID);
    component.confirmReset();
    expect(component.submitting()).toBe(true);
    expect(component.confirmOpen()).toBe(false);

    component.askReset();
    // Still closed: askReset returned early on the submitting() guard.
    expect(component.confirmOpen()).toBe(false);
  });

  it('the UUID validator tolerates a non-string control value without flagging a pattern error', () => {
    const { component } = setup();
    // A programmatic null value (e.g. form.reset(null)) takes the `typeof !== "string"` branch:
    // it is treated as empty, so only `required` (not `pattern`) owns it.
    component.form.controls.userId.setValue(null as unknown as string);
    expect(component.form.controls.userId.hasError('pattern')).toBe(false);
    expect(component.form.controls.userId.hasError('required')).toBe(true);
  });

  it('reveals the UUID field error once the control is DIRTY even before it is blurred/touched', () => {
    const { component } = setup();
    // showUuid() reads `touched || dirty`; an editing operator marks the control dirty (not touched),
    // exercising the `c.dirty` side of the OR so a typed-but-invalid id surfaces its message live.
    component.form.controls.userId.setValue('not-a-uuid');
    component.form.controls.userId.markAsDirty();
    expect(component.form.controls.userId.dirty).toBe(true);
    expect(component.form.controls.userId.touched).toBe(false);
    expect(component.showUuid()).toBe(true);
  });
});
