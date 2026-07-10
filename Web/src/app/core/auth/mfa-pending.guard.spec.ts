/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { mfaPendingGuard } from './mfa-pending.guard';

function run(mfaPending: boolean, returnUrl: string | null = null) {
  const router = { createUrlTree: vi.fn(() => 'URLTREE') };
  const route = { queryParamMap: { get: vi.fn().mockReturnValue(returnUrl) } };
  TestBed.configureTestingModule({
    providers: [
      { provide: AuthService, useValue: { mfaPending: () => mfaPending } },
      { provide: Router, useValue: router },
    ],
  });
  const result = TestBed.runInInjectionContext(() =>
    mfaPendingGuard(route as never, { url: '/mfa/verify' } as never),
  );
  return { result, router };
}

describe('mfaPendingGuard (AC9)', () => {
  it('allows the verify screen when an MFA challenge is pending', () => {
    expect(run(true).result).toBe(true);
  });

  it('redirects a direct visit (no pending challenge) to /login', () => {
    const { result, router } = run(false);
    expect(result).toBe('URLTREE');
    expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {});
  });

  it('preserves the returnUrl on the redirect when present', () => {
    const { router } = run(false, '/customers');
    expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/customers' },
    });
  });

  it('a hard reload that dropped the in-memory pending state cannot bypass into the verify screen', () => {
    // A reload clears the in-memory `mfaPending` flag (it is never persisted), so re-hitting
    // /mfa/verify directly must NOT render the screen — the guard redirects back to /login and
    // carries the intended destination so the fresh password step still lands there.
    const { result, router } = run(false, '/analytics');
    expect(result).not.toBe(true);
    expect(result).toBe('URLTREE');
    expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/analytics' },
    });
  });
});
