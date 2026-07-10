/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Injects the validated, still-open MFA challenge (attached by MfaChallengeGuard) into a handler
 * parameter — the verify endpoints read it to know which user/purpose the challenge is for.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { OpenChallenge } from '../mfa-challenge.service';
import type { RequestWithMfaChallenge } from './mfa-challenge.guard';

export const CurrentMfaChallenge = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OpenChallenge =>
    ctx.switchToHttp().getRequest<RequestWithMfaChallenge & { mfaChallenge: OpenChallenge }>().mfaChallenge,
);
