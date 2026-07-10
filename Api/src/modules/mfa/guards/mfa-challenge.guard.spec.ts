/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaChallengeGuard — MfaChallengeService + ExecutionContext mocked.
 * Covers: missing cookie → 401, invalid/expired challenge → 401, and a valid challenge → true with the
 * open challenge attached to the request for the handler.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { MfaChallengeGuard } from './mfa-challenge.guard';
import type { MfaChallengeService, OpenChallenge } from '../mfa-challenge.service';

function contextWithCookie(cookie?: string): { ctx: ExecutionContext; request: { cookies: Record<string, string>; mfaChallenge?: OpenChallenge } } {
  const request = { cookies: cookie ? { ftd_mfa: cookie } : {} } as { cookies: Record<string, string>; mfaChallenge?: OpenChallenge };
  const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { ctx, request };
}

const OPEN: OpenChallenge = { id: 'c1', userId: 'u1', purpose: 'LOGIN', attemptCount: 0, maxAttempts: 5 };

describe('MfaChallengeGuard', () => {
  it('#1 rejects when no ftd_mfa cookie is present', async () => {
    const challenges = { loadOpen: jest.fn() } as unknown as MfaChallengeService;
    const guard = new MfaChallengeGuard(challenges);
    const { ctx } = contextWithCookie(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(challenges.loadOpen).not.toHaveBeenCalled();
  });

  it('#2 rejects when the challenge is invalid/expired (loadOpen → null)', async () => {
    const challenges = { loadOpen: jest.fn().mockResolvedValue(null) } as unknown as MfaChallengeService;
    const guard = new MfaChallengeGuard(challenges);
    const { ctx } = contextWithCookie('mfa_x.y');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('#3 passes and attaches the open challenge to the request', async () => {
    const challenges = { loadOpen: jest.fn().mockResolvedValue(OPEN) } as unknown as MfaChallengeService;
    const guard = new MfaChallengeGuard(challenges);
    const { ctx, request } = contextWithCookie('mfa_valid.secret');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.mfaChallenge).toEqual(OPEN);
    expect(challenges.loadOpen).toHaveBeenCalledWith('mfa_valid.secret');
  });
});
