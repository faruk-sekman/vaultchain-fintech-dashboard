/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * POST /api/v1/auth/login (public, auth-class throttle), POST /auth/refresh (public, rotates the
 * refresh token), POST /auth/logout (public, revokes/clears the cookie SESSION — remembered-device
 * trust survives by design, see logout), GET /auth/me.
 * Responses are wrapped by the global envelope interceptor as { data, meta }.
 *
 * The refresh token rides in an httpOnly cookie, never the body — XSS cannot read
 * it. CSRF surface is minimal: the cookie is SameSite=Strict and path-scoped to /api/v1/auth, and
 * every PROTECTED route authenticates with the Authorization: Bearer header (not the cookie), so a
 * forged cross-site request carries no usable credential. login/refresh/logout perform no
 * cookie-authenticated state change on protected resources.
 */
import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
// Side-effect import: loads @fastify/cookie's `declare module 'fastify'` augmentation so
// setCookie/clearCookie (FastifyReply) and cookies (FastifyRequest) are typed here too — not
// only where main.ts is in the compilation graph (e.g. openapi:generate excludes main.ts).
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Public } from '../../common/auth/public.decorator';
import { MFA_COOKIE_NAME, mfaCookieOptions } from '../mfa/guards/mfa-challenge.guard';
import { REMEMBER_COOKIE_NAME } from '../mfa/remembered-device.service';
import { AuthService, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH, refreshCookieOptions } from './auth.service';
import { AuthenticatedResponseDto, LoginResponseDto, MeResponseDto, MfaRequiredResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // auth class: 10/min/IP
  @ApiOkResponse({ type: AuthenticatedResponseDto, description: 'On success: a 15-min access token + the httpOnly refresh cookie (status `authenticated`). For an operator with opt-in MFA: status `mfa_required` with NO tokens, plus the short-lived httpOnly `ftd_mfa` challenge cookie — complete it at POST /auth/mfa/verify.' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthenticatedResponseDto | MfaRequiredResponseDto> {
    const outcome = await this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      rememberDeviceToken: req.cookies[REMEMBER_COOKIE_NAME],
    });
    if (outcome.status === 'mfa_required') {
      reply.setCookie(MFA_COOKIE_NAME, outcome.challengeToken, mfaCookieOptions(outcome.challengeTtlSeconds));
      return { status: 'mfa_required' };
    }
    reply.setCookie(REFRESH_COOKIE_NAME, outcome.session.refreshToken, refreshCookieOptions());
    return { status: 'authenticated', ...outcome.session.body };
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOkResponse({ type: LoginResponseDto, description: 'Reads the refresh token from the httpOnly cookie, rotates it, and re-sets the cookie; returns a new access token.' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponseDto> {
    const presented = req.cookies[REFRESH_COOKIE_NAME];
    if (!presented) {
      throw new UnauthorizedException({ code: 'Auth.InvalidToken', message: 'Invalid refresh token.' });
    }
    const { body, refreshToken } = await this.auth.refresh(presented);
    reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
    return body;
  }

  @Post('logout')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // auth class: 10/min/IP, public endpoint
  @HttpCode(204)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const presented = req.cookies[REFRESH_COOKIE_NAME];
    if (presented) await this.auth.logout(presented);
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    // Logout ends the SESSION only — the `ftd_remember` device trust intentionally survives (A17,
    // bugfix-backlog-2026-07). The remember-device promise is "skip the second factor on THIS
    // device until expiry/revoke"; revoking it on every logout made the feature unobservable
    // (silent refresh means the login screen only ever reappears AFTER a logout). Trust is ended
    // by TTL expiry, the self-service trusted-devices list, a password change, an MFA disable, or
    // an admin MFA reset — never by merely signing out.
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeResponseDto, description: 'Current principal + effective permissions.' })
  me(@CurrentUser() principal: AuthPrincipal): Promise<MeResponseDto> {
    return this.auth.me(principal.sub);
  }
}
