/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dashboard realtime (SSE). Two endpoints under /api/v1/dashboard:
 *   POST /stream-token  — normal Bearer auth; mints a 60s, minimally-scoped credential and SETS IT AS
 *                         AN httpOnly COOKIE (`ftd_stream`). EventSource can't send an Authorization
 *                         header, so the credential rides a cookie (sent via `withCredentials`),
 *                         NOT the URL (a token in the URL leaks
 *                         via access logs, history, and the `Referer` header). Returns 204 (no body):
 *                         the credential is never exposed to JS.
 *   GET  /stream        — the text/event-stream the dashboard subscribes to, authed by that cookie.
 *
 * The stream credential carries ONLY `scope: 'stream:read'` + the subject — NOT the operator's full
 * permission set (minimal scope). The SSE route authorizes on that scope via StreamTokenGuard; it
 * deliberately drops PermissionsGuard so the credential need not carry `customers.read` (the operator
 * already proved that permission when minting the token here).
 *
 * RECIPIENT SCOPING: the stream is subscribed via `scopedStream(subject)` — the
 * subject comes from the authenticated stream credential (StreamTokenGuard sets `request.user.sub`).
 * Broadcast customer.* events reach everyone; a PRIVATE `notification.created` reaches ONLY the
 * recipient whose subject matches. This server-side filter is the security boundary — a connected
 * user never receives another user's notification event.
 *
 * Events carry no PII (just id + type + timestamp); the client re-fetches the masked aggregates on
 * each signal. A 25s `ping` (a NAMED event, so it never hits the client's onmessage) keeps the
 * connection warm through idle-proxy timeouts. The response-envelope interceptor passes
 * text/event-stream responses through untouched so the SSE framing isn't double-wrapped.
 */
import { Controller, HttpCode, Post, Res, Sse, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
// Side-effect import: loads @fastify/cookie's `declare module 'fastify'` augmentation so
// reply.setCookie is typed here too (not only where main.ts is in the compilation graph).
import '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { Observable, interval, map, merge } from 'rxjs';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { Public } from '../../common/auth/public.decorator';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { RealtimeService } from './realtime.service';
import {
  STREAM_COOKIE_NAME,
  STREAM_TOKEN_SCOPE,
  STREAM_TOKEN_TTL_SECONDS,
  StreamTokenGuard,
  streamCookieOptions,
} from './stream-token.guard';

/** Shape the Nest SSE writer reads: `data` (object is JSON-stringified) + optional named `type`. */
interface SseMessage {
  data: string | object;
  type?: string;
  id?: string;
  retry?: number;
}

const KEEPALIVE_INTERVAL_MS = 25_000;

@ApiTags('dashboard')
@Controller('dashboard')
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly jwt: JwtService,
  ) {}

  @Post('stream-token')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('customers.read')
  @ApiBearerAuth()
  @ApiNoContentResponse({
    description:
      'Sets a short-lived (60s) httpOnly cookie (`ftd_stream`, scope `stream:read`) used to authenticate GET /dashboard/stream. No body — the credential is never exposed to JS.',
  })
  async streamToken(
    @CurrentUser() user: AuthPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    // Minimal-scope credential: subject + `stream:read` ONLY — NOT the operator's permission set.
    const token = await this.jwt.signAsync(
      { sub: user.sub, scope: STREAM_TOKEN_SCOPE },
      { expiresIn: `${STREAM_TOKEN_TTL_SECONDS}s` },
    );
    reply.setCookie(STREAM_COOKIE_NAME, token, streamCookieOptions());
  }

  // @Public() exempts this route from the GLOBAL JwtAuthGuard (D-12): an EventSource
  // cannot send an Authorization header, so the SSE stream is authed by the httpOnly `ftd_stream`
  // cookie via StreamTokenGuard below — which remains the real gate.
  @Public()
  @Sse('stream')
  // Authed by the httpOnly `ftd_stream` cookie. The `stream:read` scope IS the authorization, so this
  // route deliberately does NOT use PermissionsGuard (that would force the credential to carry the
  // full operator permission set, defeating minimal scope). StreamTokenGuard attaches the minimal
  // principal (`{ sub, permissions: [] }`) read below via @CurrentUser.
  @UseGuards(StreamTokenGuard)
  stream(@CurrentUser() user: AuthPrincipal): Observable<SseMessage> {
    // RECIPIENT-SCOPED subscription (security gate): scopedStream filters PRIVATE events
    // (notification.created) to this authenticated subject only; broadcast customer.* events pass to
    // all. This is the server-side boundary that prevents cross-user notification leakage.
    const events$ = this.realtime
      .scopedStream(user.sub)
      // Name the PRIVATE notification.created event so the browser fires the FE's
      // addEventListener('notification.created') (live badge/list); broadcast customer.* events stay
      // unnamed (default `message`) so existing dashboard/customer-event consumers are unchanged.
      .pipe(
        map((event) =>
          event.type === 'notification.created'
            ? ({ type: 'notification.created', data: event } as SseMessage)
            : ({ data: event } as SseMessage),
        ),
      );
    const keepalive$ = interval(KEEPALIVE_INTERVAL_MS).pipe(
      map(() => ({ type: 'ping', data: 'keepalive' }) as SseMessage),
    );
    return merge(events$, keepalive$);
  }
}
