/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA challenge guard. Protects the MFA verify endpoints: reads the opaque
 * challenge from the httpOnly `ftd_mfa` cookie, validates it via MfaChallengeService (fail-closed —
 * any malformed/unknown/expired/consumed/exhausted challenge → 401), and attaches the still-open
 * challenge to the request for the handler (read it with `@CurrentMfaChallenge()`). The cookie mirrors
 * the refresh-token posture: httpOnly + SameSite=Strict + path-scoped to /api/v1/auth, so XSS can't
 * read it and the CSRF surface stays minimal.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
// Side-effect import: loads @fastify/cookie's `declare module 'fastify'` augmentation so
// `request.cookies` is typed here (not only where main.ts is in the compilation graph).
import '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import { MfaChallengeService, OpenChallenge } from '../mfa-challenge.service';

/** Name of the httpOnly cookie that carries the opaque MFA challenge token. */
export const MFA_COOKIE_NAME = 'ftd_mfa';
/** Path scope: the challenge cookie is only ever sent to the auth endpoints that mint/verify it. */
export const MFA_COOKIE_PATH = '/api/v1/auth';

/** Request augmented with the validated, still-open challenge the guard attached. */
export type RequestWithMfaChallenge = FastifyRequest & { mfaChallenge?: OpenChallenge };

/**
 * httpOnly cookie attributes for the challenge token, mirroring `refreshCookieOptions`. `secure` is
 * gated to production (a Secure cookie is never stored over http://localhost). SameSite=Strict + the
 * path scope keep the CSRF surface minimal. `maxAge` is the challenge TTL so cookie and DB row expire
 * together (the caller passes MFA_CHALLENGE_TTL).
 */
export function mfaCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: MFA_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

@Injectable()
export class MfaChallengeGuard implements CanActivate {
  constructor(private readonly challenges: MfaChallengeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithMfaChallenge>();
    const token = request.cookies?.[MFA_COOKIE_NAME] ?? null;
    if (!token) {
      throw new UnauthorizedException({ code: 'Mfa.ChallengeMissing', message: 'No MFA challenge in progress.' });
    }
    const challenge = await this.challenges.loadOpen(token);
    if (!challenge) {
      throw new UnauthorizedException({ code: 'Mfa.ChallengeInvalid', message: 'The MFA challenge is invalid or expired.' });
    }
    request.mfaChallenge = challenge;
    return true;
  }
}
