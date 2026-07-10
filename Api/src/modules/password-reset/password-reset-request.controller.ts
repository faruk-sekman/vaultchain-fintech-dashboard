/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Public admin-approval reset-request endpoints (A15/A16). Two @Public POSTs, both credential-less —
 * the httpOnly, SameSite=Strict `ftd_pwreq` cookie (path-scoped to /api/v1/auth, mirroring
 * pwResetCookieOptions) is the ONLY handle between a browser and its request:
 *
 *   POST /auth/password/reset-request — ALWAYS 202 { status: 'reset_request_received' } and ALWAYS a
 *     Set-Cookie ftd_pwreq (real for a fresh/rotated request, structurally-identical DECOY on every
 *     other branch) — the response is byte-identical for every account state (A16: no "already
 *     pending" variant; the one neutral message serves everyone). Throttled 3/min/IP.
 *
 *   POST /auth/password/reset-request/status — the owner's poll/claim. POST (not GET) because the
 *     claim is a side effect; SameSite=Strict is the CSRF control. NO guard and NEVER 401/404 — the
 *     cookie is read directly and any missing/unknown/decoy token fail-closes to { status: 'pending' }.
 *     On a claimed approval the response ALSO sets the standard ftd_pwreset challenge cookie
 *     (pre-stamped 'admin_approval') so the EXISTING /auth/password/reset/verify completes the reset.
 *     Throttled 10/min/IP.
 *
 * Emails/codes/tokens are never logged — the request body is never written to logs.
 */
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
// Side-effect import: loads @fastify/cookie's typing augmentation (request.cookies / reply.setCookie).
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { CreateResetRequestDto } from './dto/create-reset-request.dto';
import { ResetRequestReceivedResponseDto, ResetRequestStatusResponseDto } from './dto/reset-request.dto';
import { PWRESET_COOKIE_NAME, pwResetCookieOptions } from './guards/password-reset-challenge.guard';
import { PWRESET_REQUEST_COOKIE_NAME } from './password-reset.constants';
import { PasswordResetRequestService } from './password-reset-request.service';

const CREATE_THROTTLE = { default: { limit: 3, ttl: 60_000 } } as const; // 3/min/IP — tighter than initiate (A16)
const STATUS_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const; // poll cadence: auth class 10/min/IP

@ApiTags('auth')
@Controller('auth/password/reset-request')
export class PasswordResetRequestController {
  constructor(private readonly resetRequests: PasswordResetRequestService) {}

  @Post()
  @Public()
  @HttpCode(202)
  @Throttle(CREATE_THROTTLE)
  @ApiAcceptedResponse({
    type: ResetRequestReceivedResponseDto,
    description:
      'Ask an administrator to reset the password for an account. ALWAYS responds 202 { status: "reset_request_received" } and ALWAYS sets the httpOnly ftd_pwreq cookie (a decoy on non-created branches) — no user enumeration: unknown email, duplicate open request, and cooldown are indistinguishable from a fresh request. At most one open request per account; poll the status endpoint (with the cookie) for the owner-only outcome.',
  })
  async create(
    @Body() dto: CreateResetRequestDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResetRequestReceivedResponseDto> {
    const presented = req.cookies?.[PWRESET_REQUEST_COOKIE_NAME] ?? null;
    const result = await this.resetRequests.create(dto.email, presented, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    // EVERY branch sets the cookie (real or decoy) — the Set-Cookie header is uniform by design.
    reply.setCookie(
      PWRESET_REQUEST_COOKIE_NAME,
      result.requestToken,
      pwResetCookieOptions(result.requestTtlSeconds),
    );
    return { status: 'reset_request_received' };
  }

  @Post('status')
  @Public()
  @HttpCode(200)
  @Throttle(STATUS_THROTTLE)
  @ApiOkResponse({
    type: ResetRequestStatusResponseDto,
    description:
      "Poll the caller's own reset request, keyed by the httpOnly ftd_pwreq cookie. NEVER 401/404 — a missing/unknown/decoy token reads as { status: 'pending' }. On an approved, unclaimed request the call CLAIMS it: a standard ftd_pwreset challenge cookie (factor pre-stamped 'admin_approval', bound to this call's IP/UA) is set so POST /auth/password/reset/verify can finish with the new password. Re-polling re-mints (latest wins); after completion the status stays 'approved' with no cookie. POST because the claim is a side effect; SameSite=Strict is the CSRF control.",
  })
  async status(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ResetRequestStatusResponseDto> {
    const presented = req.cookies?.[PWRESET_REQUEST_COOKIE_NAME] ?? null;
    const result = await this.resetRequests.status(presented, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    if (result.challengeToken && result.challengeTtlSeconds !== undefined) {
      reply.setCookie(PWRESET_COOKIE_NAME, result.challengeToken, pwResetCookieOptions(result.challengeTtlSeconds));
    }
    return { status: result.status };
  }
}
