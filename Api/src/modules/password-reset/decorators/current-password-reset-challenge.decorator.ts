/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Injects the validated, still-open password-reset challenge (attached by PasswordResetChallengeGuard)
 * into a handler parameter — the verify endpoint reads it to know which user the challenge is for.
 * Clone of @CurrentMfaChallenge.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { OpenResetChallenge } from '../password-reset-challenge.service';
import type { RequestWithResetChallenge } from '../guards/password-reset-challenge.guard';

export const CurrentPasswordResetChallenge = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OpenResetChallenge =>
    ctx
      .switchToHttp()
      .getRequest<RequestWithResetChallenge & { passwordResetChallenge: OpenResetChallenge }>().passwordResetChallenge,
);
