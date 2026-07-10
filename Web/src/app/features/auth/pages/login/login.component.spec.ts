/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { LoginComponent } from './login.component';
import { AuthService } from '@core/auth/auth.service';
import loginTemplate from './login.component.html?raw';

// The lang + theme controls moved to AuthHeaderControlsComponent, so LoginComponent now injects only
// FormBuilder/AuthService/Router/ActivatedRoute.
function setup(returnUrl: string | null = null) {
  // Default login resolves to an `authenticated` result (discriminated union).
  const auth = { login: vi.fn().mockReturnValue(of({ status: 'authenticated' })) };
  const router = { navigateByUrl: vi.fn(), navigate: vi.fn() };
  const route = { snapshot: { queryParamMap: { get: vi.fn().mockReturnValue(returnUrl) } } };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      { provide: ActivatedRoute, useValue: route },
    ],
  });

  const component = TestBed.runInInjectionContext(() => new LoginComponent());
  return { component, auth, router };
}

/**
 * Structure-level "render" of the SHIPPED template (v2 §5 assertions).
 * This vitest setup has no Angular external-resource loader (repo convention is
 * class-level specs), so the raw template is parsed as a DOM document instead:
 * Angular control-flow braces become text nodes while every element stays queryable.
 */
function renderTemplate(): Document {
  return new DOMParser().parseFromString(loginTemplate, 'text/html');
}

describe('LoginComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('togglePassword flips the showPassword signal', () => {
    const { component } = setup();
    expect(component.showPassword()).toBe(false);
    component.togglePassword();
    expect(component.showPassword()).toBe(true);
    component.togglePassword();
    expect(component.showPassword()).toBe(false);
  });

  it('does not call AuthService.login when the form is invalid', () => {
    const { component, auth } = setup();
    component.submit();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('submits valid credentials and navigates to the dashboard by default', () => {
    const { component, auth, router } = setup();
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(auth.login).toHaveBeenCalledWith('op@example.com', 'password123');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    expect(component.submitting()).toBe(false);
  });

  it('honors a returnUrl query param on success', () => {
    const { component, router } = setup('/customers');
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/customers');
  });

  it('routes to /mfa/verify (not the landing) when login returns mfa_required (AC1)', () => {
    const { component, auth, router } = setup('/analytics');
    auth.login.mockReturnValueOnce(of({ status: 'mfa_required' }));
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    // No direct landing navigation; the challenge screen takes over, carrying the returnUrl.
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/mfa/verify'], {
      queryParams: { returnUrl: '/analytics' },
    });
  });

  it.each(['https://evil.example', '//evil.example', '\\evil'])(
    'falls back to dashboard for unsafe returnUrl %s',
    returnUrl => {
      const { component, router } = setup(returnUrl);
      component.form.setValue({ email: 'op@example.com', password: 'password123' });
      component.submit();
      expect(router.navigateByUrl).toHaveBeenCalledWith('/dashboard');
    },
  );

  it('surfaces a generic invalid-credentials key on 401 (no enumeration)', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.errorKey()).toBe('auth.login.invalid');
    expect(component.submitting()).toBe(false);
  });

  it('surfaces a generic failure key on non-401 errors', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(throwError(() => ({ status: 500 })));
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.errorKey()).toBe('auth.login.failed');
  });

  it('surfaces the lockout key on a 429 without Retry-After', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(throwError(() => ({ status: 429 })));
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.errorKey()).toBe('auth.login.locked');
    expect(component.errorParams()).toBeUndefined();
  });

  it('surfaces the lockout-with-wait key + seconds when 429 carries a numeric Retry-After', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(
      throwError(() => ({
        status: 429,
        headers: { get: (h: string) => (h === 'Retry-After' ? '30' : null) },
      })),
    );
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.errorKey()).toBe('auth.login.lockedRetry');
    expect(component.errorParams()).toEqual({ seconds: 30 });
  });

  it('falls back to the plain lockout key when Retry-After is a non-numeric (HTTP-date) value', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(
      throwError(() => ({
        status: 429,
        headers: { get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' },
      })),
    );
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.errorKey()).toBe('auth.login.locked');
    expect(component.errorParams()).toBeUndefined();
  });

  it('ships the showcase two-pane login: shared brand pane + form + demo shortcuts', () => {
    const doc = renderTemplate();

    // Two-pane shell: the SHARED animated brand pane (left) + the auth panel (right). The brand
    // lockup, carousel and lang/theme controls now live in the shared child components, asserted by
    // their element tags (their internals are covered by auth-brand-pane / auth-header-controls specs).
    expect(doc.querySelector('.login__shell')).not.toBeNull();
    expect(loginTemplate).toContain('<app-auth-brand-pane');
    expect(doc.querySelector('.login__panel')).not.toBeNull();
    expect(loginTemplate).toContain('<app-auth-header-controls');

    // The single page H1 is the form's "welcome" title (the rotating hero slides are not headings).
    expect(doc.querySelectorAll('h1').length).toBe(1);
    expect(doc.querySelector('h1.login__title')?.textContent).toContain('auth.login.formTitle');
    // The retired split-panel keys must not creep back in.
    expect(loginTemplate).not.toContain('auth.brand.');
    expect(loginTemplate).not.toContain('auth.login.secureNote');

    // Same auth surface: exactly one form card; email + password controls (autocomplete
    // preserved); subtitle line; and the primary submit button (the design's gradient button).
    expect(doc.querySelectorAll('form.login__card').length).toBe(1);
    expect(doc.querySelector('.login__subtitle')?.textContent).toContain('auth.login.subtitle');
    expect(doc.querySelector('input#login-email[autocomplete="username"]')).not.toBeNull();
    expect(
      doc.querySelector('input#login-password[autocomplete="current-password"]'),
    ).not.toBeNull();
    const submit = doc.querySelector('button.login__submit');
    expect(submit).not.toBeNull();
    expect(submit?.getAttribute('type')).toBe('submit');

    // Demo showcase: a section with a fill-the-form button wired to useDemoAccount.
    expect(doc.querySelector('section.login__demo')).not.toBeNull();
    expect(doc.querySelector('button.login__demo-card')).not.toBeNull();
    expect(loginTemplate).toContain('useDemoAccount(account)');
    expect(loginTemplate).toContain('demoAccounts');
  });

  it('exposes the 3 seed demo accounts (admin/operator/auditor) with the dev password', () => {
    const { component } = setup();
    expect(component.demoAccounts.map(a => a.email)).toEqual([
      'admin@example.com',
      'operator@example.com',
      'auditor@example.com',
    ]);
    expect(component.demoAccounts.map(a => a.roleKey)).toEqual([
      'administrator',
      'operator',
      'auditor',
    ]);
    for (const account of component.demoAccounts) {
      expect(account.password).toBe('Test-Passw0rd!');
    }
  });

  it('ignores a second submit while one is already in flight (submitting guard)', () => {
    const { component, auth } = setup();
    auth.login.mockReturnValueOnce(NEVER); // never completes → submitting stays true
    component.form.setValue({ email: 'op@example.com', password: 'password123' });
    component.submit();
    expect(component.submitting()).toBe(true);
    component.submit(); // second call must early-return (no extra login)
    expect(auth.login).toHaveBeenCalledTimes(1);
  });

  it('useDemoAccount drives the click-ripple: sets the role next tick, then clears after 660ms', () => {
    // Repo is zoneless → drive the setTimeout-based ripple with vitest fake timers (not fakeAsync).
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.useDemoAccount(component.demoAccounts[0]); // administrator
      expect(component.pulsingRole()).toBeNull(); // dropped immediately
      vi.advanceTimersByTime(0); // next-tick set
      expect(component.pulsingRole()).toBe('administrator');
      vi.advanceTimersByTime(660); // keyframe duration elapsed → cleared
      expect(component.pulsingRole()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a newer demo-card click cancels the prior ripple timers (seq guard)', () => {
    vi.useFakeTimers();
    try {
      const { component } = setup();
      component.useDemoAccount(component.demoAccounts[0]); // seq 1
      component.useDemoAccount(component.demoAccounts[2]); // seq 2 (supersedes)
      vi.advanceTimersByTime(0); // only the latest (seq 2) set should win
      expect(component.pulsingRole()).toBe('auditor');
      vi.advanceTimersByTime(660);
      expect(component.pulsingRole()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('useDemoAccount prefills the form and clears a prior error, without auto-submitting', () => {
    const { component, auth } = setup();
    component.errorKey.set('auth.login.invalid');
    component.errorParams.set({ seconds: 30 });

    component.useDemoAccount(component.demoAccounts[1]); // Compliance Officer

    expect(component.form.getRawValue()).toEqual({
      email: 'operator@example.com',
      password: 'Test-Passw0rd!',
    });
    expect(component.errorKey()).toBeNull();
    expect(component.errorParams()).toBeUndefined();
    // Fill only — the visitor presses "Sign in"; no auth call is made by the shortcut (D2).
    expect(auth.login).not.toHaveBeenCalled();
  });

  // The welcome carousel (slides / goToSlide / typewriter) and the lang/theme controls moved to the
  // shared AuthBrandPaneComponent / AuthHeaderControlsComponent — their behaviour is covered by
  // auth-brand-pane.component.spec.ts and auth-header-controls.component.spec.ts.
});
