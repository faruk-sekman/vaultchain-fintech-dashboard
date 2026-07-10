/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for StreamTokenGuard (SSE auth). Covers: missing `ftd_stream` cookie,
 * a valid cookie with the correct `stream:read` scope, a wrong-scope token, an invalid/expired
 * token, the rotation-secret fallback seam, and the streamCookieOptions() `secure` prod-gating.
 * Hermetic: JwtService + ExecutionContext mocked; no DB/Redis/EventSource.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import {
  STREAM_COOKIE_NAME,
  STREAM_COOKIE_PATH,
  STREAM_TOKEN_SCOPE,
  STREAM_TOKEN_TTL_SECONDS,
  StreamTokenGuard,
  streamCookieOptions,
} from './stream-token.guard';

type StreamRequest = FastifyRequest & {
  cookies?: Record<string, string | undefined>;
  user?: { sub: string; permissions: string[] };
};

function contextWith(cookies?: Record<string, string | undefined>): {
  context: ExecutionContext;
  request: StreamRequest;
} {
  const request = { cookies } as StreamRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('StreamTokenGuard', () => {
  const ORIGINAL_PREVIOUS = process.env.JWT_ACCESS_SECRET_PREVIOUS;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    if (ORIGINAL_PREVIOUS === undefined) delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    else process.env.JWT_ACCESS_SECRET_PREVIOUS = ORIGINAL_PREVIOUS;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    jest.restoreAllMocks();
  });

  it('throws Auth.StreamTokenMissing (401) when no cookies object is present', async () => {
    const guard = new StreamTokenGuard({ verifyAsync: jest.fn() } as unknown as JwtService);
    const { context } = contextWith(undefined);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.StreamTokenMissing' },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws Auth.StreamTokenMissing when the ftd_stream cookie is absent', async () => {
    const jwt = { verifyAsync: jest.fn() } as unknown as JwtService;
    const guard = new StreamTokenGuard(jwt);
    const { context } = contextWith({ some_other_cookie: 'x' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.StreamTokenMissing' },
    });
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('attaches a minimal (no-permissions) principal for a valid stream:read token', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'op-1', scope: STREAM_TOKEN_SCOPE }),
    } as unknown as JwtService;
    const guard = new StreamTokenGuard(jwt);
    const { context, request } = contextWith({ [STREAM_COOKIE_NAME]: 'valid.stream.jwt' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('valid.stream.jwt', {});
    // Scope IS the authorization → principal carries the subject but NO permissions.
    expect(request.user).toEqual({ sub: 'op-1', permissions: [], permissionVersion: 0 });
  });

  it('throws Auth.StreamTokenInvalid (401) when the token has the WRONG scope', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'op-2', scope: 'customers.read' }),
    } as unknown as JwtService;
    const guard = new StreamTokenGuard(jwt);
    const { context, request } = contextWith({ [STREAM_COOKIE_NAME]: 'wrong.scope.jwt' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.StreamTokenInvalid' },
    });
    expect(request.user).toBeUndefined();
  });

  it('throws Auth.StreamTokenInvalid when the scope claim is missing entirely', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'op-3' }),
    } as unknown as JwtService;
    const guard = new StreamTokenGuard(jwt);
    const { context } = contextWith({ [STREAM_COOKIE_NAME]: 'no.scope.jwt' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.StreamTokenInvalid' },
    });
  });

  it('throws Auth.StreamTokenInvalid when verification itself fails (expired/invalid)', async () => {
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    const jwt = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('jwt expired')),
    } as unknown as JwtService;
    const guard = new StreamTokenGuard(jwt);
    const { context } = contextWith({ [STREAM_COOKIE_NAME]: 'expired.jwt' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.StreamTokenInvalid' },
    });
    expect(jwt.verifyAsync).toHaveBeenCalledTimes(1);
  });

  it('rotation seam: a token signed with the PREVIOUS secret still authorizes the stream', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = 'old-stream-secret';
    const verifyAsync = jest
      .fn()
      .mockRejectedValueOnce(new Error('current rejects'))
      .mockResolvedValueOnce({ sub: 'op-rot', scope: STREAM_TOKEN_SCOPE });
    const guard = new StreamTokenGuard({ verifyAsync } as unknown as JwtService);
    const { context, request } = contextWith({ [STREAM_COOKIE_NAME]: 'rotated.stream.jwt' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenLastCalledWith('rotated.stream.jwt', { secret: 'old-stream-secret' });
    expect(request.user).toEqual({ sub: 'op-rot', permissions: [], permissionVersion: 0 });
  });
});

describe('streamCookieOptions', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('uses Secure cookies in production', () => {
    process.env.NODE_ENV = 'production';
    expect(streamCookieOptions()).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: STREAM_COOKIE_PATH,
      maxAge: STREAM_TOKEN_TTL_SECONDS,
    });
  });

  it('disables Secure outside production so the dev/local cookie is actually stored over http', () => {
    process.env.NODE_ENV = 'development';
    const opts = streamCookieOptions();
    expect(opts.secure).toBe(false);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe(STREAM_COOKIE_PATH);
    expect(opts.maxAge).toBe(STREAM_TOKEN_TTL_SECONDS);
  });

  it('exposes a short (≤60s) TTL and the dashboard-scoped cookie path', () => {
    expect(STREAM_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60);
    expect(STREAM_COOKIE_PATH).toBe('/api/v1/dashboard');
    expect(STREAM_COOKIE_NAME).toBe('ftd_stream');
  });
});
