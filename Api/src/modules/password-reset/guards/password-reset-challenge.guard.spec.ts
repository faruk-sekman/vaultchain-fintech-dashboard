/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetChallengeGuard — service + ExecutionContext mocked.
 * Mirrors the MfaChallengeGuard suite. Covers: missing cookie -> 401 (stable code), invalid/expired
 * challenge -> 401 (stable code), a valid challenge -> true with the open challenge attached, and the
 * pwResetCookieOptions shape.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { PasswordResetChallengeGuard, pwResetCookieOptions } from './password-reset-challenge.guard';
import type { OpenResetChallenge, PasswordResetChallengeService } from '../password-reset-challenge.service';

function contextWithCookie(cookie?: string): {
  ctx: ExecutionContext;
  request: { cookies: Record<string, string>; passwordResetChallenge?: OpenResetChallenge };
} {
  const request = { cookies: cookie ? { ftd_pwreset: cookie } : {} } as {
    cookies: Record<string, string>;
    passwordResetChallenge?: OpenResetChallenge;
  };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { ctx, request };
}

const OPEN: OpenResetChallenge = {
  id: 'c1',
  userId: 'u1',
  purpose: 'PASSWORD_RESET',
  attemptCount: 0,
  maxAttempts: 5,
  createdIpHash: null,
  uaHash: null,
  factorVerifiedAt: null,
  factorMethod: null,
};

describe('PasswordResetChallengeGuard', () => {
  it('#1 rejects with Auth.ResetChallengeMissing when no ftd_pwreset cookie is present', async () => {
    const challenges = { loadOpen: jest.fn() } as unknown as PasswordResetChallengeService;
    const guard = new PasswordResetChallengeGuard(challenges);
    const { ctx } = contextWithCookie(undefined);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'Auth.ResetChallengeMissing' } });
    expect(challenges.loadOpen).not.toHaveBeenCalled();
  });

  it('#2 rejects with Auth.ResetChallengeInvalid when loadOpen -> null', async () => {
    const challenges = { loadOpen: jest.fn().mockResolvedValue(null) } as unknown as PasswordResetChallengeService;
    const guard = new PasswordResetChallengeGuard(challenges);
    const { ctx } = contextWithCookie('pwr_x.y');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'Auth.ResetChallengeInvalid' } });
  });

  it('#3 passes and attaches the open challenge to the request', async () => {
    const challenges = { loadOpen: jest.fn().mockResolvedValue(OPEN) } as unknown as PasswordResetChallengeService;
    const guard = new PasswordResetChallengeGuard(challenges);
    const { ctx, request } = contextWithCookie('pwr_valid.secret');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.passwordResetChallenge).toEqual(OPEN);
    expect(challenges.loadOpen).toHaveBeenCalledWith('pwr_valid.secret');
  });

  it('#4 pwResetCookieOptions: httpOnly + SameSite=Strict + path-scoped + ttl maxAge; secure off outside prod', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const opts = pwResetCookieOptions(300);
    expect(opts).toEqual({ httpOnly: true, sameSite: 'strict', secure: false, path: '/api/v1/auth', maxAge: 300 });
    process.env.NODE_ENV = 'production';
    expect(pwResetCookieOptions(120).secure).toBe(true);
    process.env.NODE_ENV = prev;
  });
});
