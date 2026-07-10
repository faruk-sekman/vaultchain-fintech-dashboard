/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA verify endpoints. Thin controller: the httpOnly `ftd_mfa` challenge
 * cookie is the credential (validated by MfaChallengeGuard), the verify logic lives in MfaLoginService,
 * and this controller only translates the result into cookies (set `ftd_refresh`, clear the spent
 * `ftd_mfa`, optionally set `ftd_remember`) + the response body. Lives in the AUTH module so the verify
 * flow can reuse AuthService session issuance without a circular module dependency (sanctioned
 * auth->mfa coupling). Brute force: per-challenge attempt counter + per-IP throttle, no account lockout.
 */
import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
// Side-effect import: loads @fastify/cookie's typing augmentation (request.cookies / reply.setCookie).
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { VerifyBackupCodeDto, VerifyTotpDto } from '../mfa/dto/mfa.dto';
import { CurrentMfaChallenge } from '../mfa/guards/current-mfa-challenge.decorator';
import { MFA_COOKIE_NAME, MFA_COOKIE_PATH, MfaChallengeGuard } from '../mfa/guards/mfa-challenge.guard';
import { OpenChallenge } from '../mfa/mfa-challenge.service';
import { REMEMBER_COOKIE_NAME, rememberCookieOptions } from '../mfa/remembered-device.service';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from './auth.service';
import { AuthenticatedResponseDto } from './dto/auth-response.dto';
import { MfaLoginResult, MfaLoginService } from './mfa-login.service';

const VERIFY_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // auth class: 10/min/IP

@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfaLogin: MfaLoginService) {}

  @Post('verify')
  @Public()
  @HttpCode(200)
  @Throttle(VERIFY_THROTTLE)
  @UseGuards(MfaChallengeGuard)
  @ApiOkResponse({
    type: AuthenticatedResponseDto,
    description: 'Verify a TOTP code for the in-progress login challenge. On success the session is issued (ftd_refresh set, ftd_mfa cleared); on failure the per-challenge attempt counter advances.',
  })
  async verify(
    @CurrentMfaChallenge() challenge: OpenChallenge,
    @Body() dto: VerifyTotpDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthenticatedResponseDto> {
    const result = await this.mfaLogin.verifyTotp(challenge, dto.code, dto.rememberDevice ?? false, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return this.issueCookies(result, reply);
  }

  @Post('backup-code/verify')
  @Public()
  @HttpCode(200)
  @Throttle(VERIFY_THROTTLE)
  @UseGuards(MfaChallengeGuard)
  @ApiOkResponse({
    type: AuthenticatedResponseDto,
    description: 'Redeem a one-time backup code for the in-progress login challenge and issue the session. Remember-device is not offered on the recovery path.',
  })
  async verifyBackupCode(
    @CurrentMfaChallenge() challenge: OpenChallenge,
    @Body() dto: VerifyBackupCodeDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthenticatedResponseDto> {
    const result = await this.mfaLogin.verifyBackupCode(challenge, dto.code, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return this.issueCookies(result, reply);
  }

  /** Set the session cookie, clear the spent challenge cookie, optionally set the remember-device cookie. */
  private issueCookies(result: MfaLoginResult, reply: FastifyReply): AuthenticatedResponseDto {
    reply.setCookie(REFRESH_COOKIE_NAME, result.session.refreshToken, refreshCookieOptions());
    reply.clearCookie(MFA_COOKIE_NAME, { path: MFA_COOKIE_PATH });
    if (result.rememberDevice) {
      reply.setCookie(REMEMBER_COOKIE_NAME, result.rememberDevice.token, rememberCookieOptions(result.rememberDevice.ttlSeconds));
    }
    return { status: 'authenticated', ...result.session.body };
  }
}
