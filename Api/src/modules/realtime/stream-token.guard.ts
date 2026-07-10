/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * SSE authentication (dashboard realtime). The browser EventSource API cannot set an Authorization
 * header, so the stream is authenticated by a SHORT-LIVED (60s), single-purpose JWT delivered as an
 * httpOnly cookie (`ftd_stream`, set by POST /dashboard/stream-token; sent by EventSource via
 * `withCredentials:true`). This guard reads + verifies that cookie and attaches a MINIMAL principal.
 * Fail-closed (any problem -> 401).
 *
 * Token-in-URL fix: the credential previously rode the query
 * string (`?token=`), which leaks via access logs, browser history, and the `Referer` header. It now
 * rides an httpOnly cookie — no token appears in the URL.
 *
 * Minimal scope (security): the stream credential carries ONLY `scope: 'stream:read'` and the
 * subject — NOT the operator's full permission set. The `stream:read` scope IS the authorization for
 * the read-only SSE (the operator already proved `customers.read` when minting the token at the
 * full-auth POST /dashboard/stream-token). So this guard authorizes on scope alone; it deliberately
 * does not require the operator permission set, and attaches NO permissions to the principal.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
// Side-effect import: loads @fastify/cookie's `declare module 'fastify'` augmentation so
// `request.cookies` is typed here too (not only where main.ts is in the compilation graph).
import '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { verifyWithRotation } from '../../common/auth/jwt-rotation';

/** Scope claim that distinguishes a stream credential from a normal access token. */
export const STREAM_TOKEN_SCOPE = 'stream:read';

/** Name of the httpOnly cookie that carries the short-lived stream credential. */
export const STREAM_COOKIE_NAME = 'ftd_stream';

/** Path scope: the stream cookie is only ever sent to the dashboard SSE endpoints. */
export const STREAM_COOKIE_PATH = '/api/v1/dashboard';

/** Stream-credential / cookie lifetime — short (≤60s) to bound any exposure window. */
export const STREAM_TOKEN_TTL_SECONDS = 60;

/**
 * httpOnly cookie attributes for the stream credential. `secure` is gated to production: on
 * http://localhost a Secure cookie would never be stored, so it MUST be false in dev/local. `SameSite=Lax`
 * (not Strict) is required so the cookie is sent on the EventSource GET handshake while still blocking
 * cross-site sends; same-site cross-PORT (dev :4200 -> :3000, same registrable domain `localhost`) is
 * unaffected, so it is sent in dev. `httpOnly` keeps it out of JS (XSS can't read it). `maxAge` mirrors
 * the token TTL so the cookie and the credential expire together.
 */
export function streamCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: STREAM_COOKIE_PATH,
    maxAge: STREAM_TOKEN_TTL_SECONDS,
  };
}

@Injectable()
export class StreamTokenGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthPrincipal }>();
    const token = request.cookies?.[STREAM_COOKIE_NAME] ?? null;
    if (!token) {
      throw new UnauthorizedException({
        code: 'Auth.StreamTokenMissing',
        message: 'A stream credential is required.',
      });
    }

    try {
      // Rotation-aware verify (current secret, then JWT_ACCESS_SECRET_PREVIOUS if set).
      const payload = await verifyWithRotation<{ sub: string; scope?: string }>(this.jwt, token);
      if (payload.scope !== STREAM_TOKEN_SCOPE) throw new Error('wrong scope');
      // Minimal principal: subject only, NO permissions — the scope is the authorization. permissionVersion
      // is irrelevant here (the SSE route is scope-gated via this guard, not PermissionsGuard-gated), so a
      // static 0 satisfies the AuthPrincipal contract without ever being version-checked.
      request.user = { sub: payload.sub, permissions: [], permissionVersion: 0 };
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'Auth.StreamTokenInvalid',
        message: 'The stream credential is invalid or expired.',
      });
    }
  }
}
