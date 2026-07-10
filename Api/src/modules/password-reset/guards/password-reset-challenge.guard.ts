/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset challenge guard. A clone of MfaChallengeGuard. Protects the
 * reset-verify endpoint: reads the opaque challenge from the httpOnly `ftd_pwreset` cookie, validates it
 * via PasswordResetChallengeService (fail-closed — any malformed/unknown/expired/consumed/exhausted
 * challenge -> 401), and attaches the still-open challenge to the request for the handler (read it with
 * `@CurrentPasswordResetChallenge()`).
 *
 * CSRF: the reset POSTs are @Public and carry NO JWT — they are credentialed ONLY by this httpOnly,
 * SameSite=Strict cookie path-scoped to /api/v1/auth. SameSite=Strict is therefore the SOLE CSRF
 * control; there is intentionally no GET side-effect variant of either reset endpoint.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
// Side-effect import: loads @fastify/cookie's `declare module 'fastify'` augmentation so
// `request.cookies` is typed here (not only where main.ts is in the compilation graph).
import '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import { OpenResetChallenge, PasswordResetChallengeService } from '../password-reset-challenge.service';

/** Name of the httpOnly cookie that carries the opaque password-reset challenge token. */
export const PWRESET_COOKIE_NAME = 'ftd_pwreset';
/** Path scope: the reset cookie is only ever sent to the auth endpoints that mint/verify it. */
export const PWRESET_COOKIE_PATH = '/api/v1/auth';

/** Request augmented with the validated, still-open reset challenge the guard attached. */
export type RequestWithResetChallenge = FastifyRequest & { passwordResetChallenge?: OpenResetChallenge };

/**
 * httpOnly cookie attributes for the reset-challenge token, mirroring `mfaCookieOptions` /
 * `refreshCookieOptions`. `secure` is gated to production (a Secure cookie is never stored over
 * http://localhost). SameSite=Strict + the path scope are the SOLE CSRF control for these @Public,
 * JWT-less endpoints. `maxAge` is the challenge TTL so cookie and DB row expire together (the caller
 * passes PWRESET_CHALLENGE_TTL).
 */
export function pwResetCookieOptions(maxAgeSeconds: number): {
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
    path: PWRESET_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

@Injectable()
export class PasswordResetChallengeGuard implements CanActivate {
  constructor(private readonly challenges: PasswordResetChallengeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithResetChallenge>();
    const token = request.cookies?.[PWRESET_COOKIE_NAME] ?? null;
    if (!token) {
      throw new UnauthorizedException({ code: 'Auth.ResetChallengeMissing', message: 'No password-reset challenge in progress.' });
    }
    const challenge = await this.challenges.loadOpen(token);
    if (!challenge) {
      throw new UnauthorizedException({ code: 'Auth.ResetChallengeInvalid', message: 'The password-reset challenge is invalid or expired.' });
    }
    request.passwordResetChallenge = challenge;
    return true;
  }
}
