/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Self-service password-reset endpoints (split into a verify-code + verify
 * pair). A SELF-CONTAINED, MFA-gated "forgot password" flow — NO email, NO JWT. Three
 * @Public POSTs:
 *
 *   POST /auth/password/reset/initiate — ALWAYS 202 { status: 'reset_initiated' }; sets the
 *     `ftd_pwreset` cookie ONLY for an MFA-enrolled account (no-enumeration: the body/status are
 *     byte-identical; the conditional Set-Cookie residual is tracked separately).
 *   POST /auth/password/reset/verify-code — guarded by PasswordResetChallengeGuard; verifies the 2nd
 *     factor (TOTP/backup) ONCE and stamps `factor_verified_at` on the challenge. 200 { status:
 *     'code_verified' }; idempotent for an already-stamped challenge; NO cookie change, NO tokens.
 *   POST /auth/password/reset/verify — guarded by PasswordResetChallengeGuard (the `ftd_pwreset` cookie
 *     is the credential) AND gated on a prior factor stamp (Auth.ResetFactorRequired otherwise); takes
 *     the new password ONLY. On success changes the password, revokes all sessions/devices/challenges,
 *     clears the cookie, and returns 200 { status: 'reset_complete' } with NO tokens / NO auto-login.
 *
 * CSRF: every endpoint is credentialed ONLY by the httpOnly, SameSite=Strict cookie scoped to
 * /api/v1/auth — SameSite=Strict is the SOLE CSRF control, and there is intentionally no GET
 * side-effect variant. Codes/passwords are never logged — the request body is never written to logs.
 */
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
// Side-effect import: loads @fastify/cookie's typing augmentation (request.cookies / reply.setCookie).
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { CurrentPasswordResetChallenge } from './decorators/current-password-reset-challenge.decorator';
import { InitiatePasswordResetDto } from './dto/initiate-password-reset.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { VerifyPasswordResetDto } from './dto/verify-password-reset.dto';
import {
  PWRESET_COOKIE_NAME,
  PWRESET_COOKIE_PATH,
  PasswordResetChallengeGuard,
  pwResetCookieOptions,
} from './guards/password-reset-challenge.guard';
import { OpenResetChallenge } from './password-reset-challenge.service';
import { PasswordResetService } from './password-reset.service';
import { ResetCodeVerifiedResponseDto, ResetCompleteResponseDto, ResetInitiatedResponseDto } from './dto/reset-response.dto';

const INITIATE_THROTTLE = { default: { limit: 5, ttl: 60_000 } } as const; // 5/min/IP — tighter than the auth class
const VERIFY_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // auth class: 10/min/IP

@ApiTags('auth')
@Controller('auth/password/reset')
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Post('initiate')
  @Public()
  @HttpCode(202)
  @Throttle(INITIATE_THROTTLE)
  @ApiAcceptedResponse({
    type: ResetInitiatedResponseDto,
    description:
      'Start a self-service password reset. ALWAYS responds 202 { status: "reset_initiated" } (no user enumeration). Sets the httpOnly ftd_pwreset challenge cookie ONLY when the account exists AND has confirmed MFA — MFA-enabled state is never revealed.',
  })
  async initiate(
    @Body() dto: InitiatePasswordResetDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResetInitiatedResponseDto> {
    const result = await this.passwordReset.initiate(dto.email, { ip: req.ip, userAgent: req.headers['user-agent'] });
    if (result.challengeToken) {
      reply.setCookie(PWRESET_COOKIE_NAME, result.challengeToken, pwResetCookieOptions(result.challengeTtlSeconds));
    }
    return { status: 'reset_initiated' };
  }

  @Post('verify-code')
  @Public()
  @HttpCode(200)
  @Throttle(VERIFY_THROTTLE)
  @UseGuards(PasswordResetChallengeGuard)
  @ApiOkResponse({
    type: ResetCodeVerifiedResponseDto,
    description:
      'Step 2: verify the second factor (6-digit TOTP or one-time backup code) ONCE and stamp the challenge (factor_verified_at). On success 200 { status: "code_verified" } — the TOTP replay floor is advanced / the backup code consumed, and the later /verify needs no code. IDEMPOTENT for an already-stamped challenge (a Back/retry does not re-spend the factor). On a bad/expired factor the per-challenge attempt counter advances and 401 Auth.ResetInvalidCode is returned. The verify-code call sets NO cookie and issues NO token.',
  })
  async verifyCode(
    @CurrentPasswordResetChallenge() challenge: OpenResetChallenge,
    @Body() dto: VerifyCodeDto,
    @Req() req: FastifyRequest,
  ): Promise<ResetCodeVerifiedResponseDto> {
    return this.passwordReset.verifyCode(challenge, dto.code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('verify')
  @Public()
  @HttpCode(200)
  @Throttle(VERIFY_THROTTLE)
  @UseGuards(PasswordResetChallengeGuard)
  @ApiOkResponse({
    type: ResetCompleteResponseDto,
    description:
      'Step 3: set the new password. Requires a prior factor stamp from verify-code (else 401 Auth.ResetFactorRequired); takes the new password ONLY (no code). On success the password is changed, ALL sessions/devices/challenges are revoked, the ftd_pwreset cookie is cleared, and NO session is issued (a fresh /login is required). The bound IP/UA fingerprint is re-enforced on this call too.',
  })
  async verify(
    @CurrentPasswordResetChallenge() challenge: OpenResetChallenge,
    @Body() dto: VerifyPasswordResetDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResetCompleteResponseDto> {
    await this.passwordReset.verify(challenge, dto.newPassword, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // Clear the spent challenge cookie. No session cookie is set — the operator must sign in fresh.
    reply.clearCookie(PWRESET_COOKIE_NAME, { path: PWRESET_COOKIE_PATH });
    return { status: 'reset_complete' };
  }
}
