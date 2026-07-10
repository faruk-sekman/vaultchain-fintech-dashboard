/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for JwtAuthGuard. Covers the @Public() bypass, the missing/malformed/valid
 * Bearer token branches, the JWT-rotation verify seam (current vs JWT_ACCESS_SECRET_PREVIOUS), and
 * the fail-closed 401 paths. Hermetic: JwtService + Reflector + ExecutionContext are mocked; no DB.
 */
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

type AuthRequest = FastifyRequest & { user?: { sub: string; permissions: string[] } };

function contextWith(request: Partial<AuthRequest>): {
  context: ExecutionContext;
  request: AuthRequest;
  handler: () => void;
  cls: () => void;
} {
  const req = request as AuthRequest;
  const handler = (): void => undefined;
  const cls = (): void => undefined;
  const context = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, request: req, handler, cls };
}

function makeReflector(isPublic: boolean | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
}

describe('JwtAuthGuard', () => {
  const ORIGINAL_PREVIOUS = process.env.JWT_ACCESS_SECRET_PREVIOUS;

  afterEach(() => {
    if (ORIGINAL_PREVIOUS === undefined) {
      delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    } else {
      process.env.JWT_ACCESS_SECRET_PREVIOUS = ORIGINAL_PREVIOUS;
    }
    jest.restoreAllMocks();
  });

  it('bypasses auth for a @Public() route (no token required)', async () => {
    const reflector = makeReflector(true);
    const jwt = { verifyAsync: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, reflector);
    const { context, request } = contextWith({ headers: {} });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Reflector consulted with BOTH handler + class targets.
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
    // Public bypass must not even look at the token / attach a principal.
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('throws Auth.TokenMissing (401) when the Authorization header is absent', async () => {
    const guard = new JwtAuthGuard({ verifyAsync: jest.fn() } as unknown as JwtService, makeReflector(false));
    const { context } = contextWith({ headers: {} });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.TokenMissing' },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws Auth.TokenMissing when the header is present but not a "Bearer " scheme', async () => {
    const jwt = { verifyAsync: jest.fn() } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, makeReflector(false));
    const { context } = contextWith({ headers: { authorization: 'Basic abc123' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.TokenMissing' },
    });
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('attaches the verified principal and returns true for a valid Bearer token', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', permissions: ['customers.read'] }),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, makeReflector(false));
    const { context, request } = contextWith({ headers: { authorization: 'Bearer good.token' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('good.token', {});
    expect(request.user).toEqual({ sub: 'user-1', permissions: ['customers.read'], permissionVersion: 0 });
  });

  it('defaults permissions to [] when the token payload omits them', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-2' }),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, makeReflector(false));
    const { context, request } = contextWith({ headers: { authorization: 'Bearer no.perms' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ sub: 'user-2', permissions: [], permissionVersion: 0 });
  });

  it('extracts the permission-snapshot version (pv) into the principal (audit F9)', async () => {
    const jwt = {
      verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-3', permissions: ['customers.read'], pv: 7 }),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, makeReflector(false));
    const { context, request } = contextWith({ headers: { authorization: 'Bearer versioned.token' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ sub: 'user-3', permissions: ['customers.read'], permissionVersion: 7 });
  });

  it('throws Auth.TokenInvalid (401) when verification fails and no rotation secret is set', async () => {
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    const jwt = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('invalid signature')),
    } as unknown as JwtService;
    const guard = new JwtAuthGuard(jwt, makeReflector(false));
    const { context } = contextWith({ headers: { authorization: 'Bearer bad.token' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.TokenInvalid' },
    });
    // current-secret-only: exactly one verify attempt.
    expect(jwt.verifyAsync).toHaveBeenCalledTimes(1);
  });

  it('rotation seam: accepts a token the PREVIOUS secret verifies after the current one fails', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = 'old-secret-value';
    const verifyAsync = jest
      .fn()
      .mockRejectedValueOnce(new Error('current secret rejects'))
      .mockResolvedValueOnce({ sub: 'rotated-user', permissions: ['p1'] });
    const guard = new JwtAuthGuard({ verifyAsync } as unknown as JwtService, makeReflector(false));
    const { context, request } = contextWith({ headers: { authorization: 'Bearer rotated.token' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledTimes(2);
    // Fallback attempt overrides only the secret.
    expect(verifyAsync).toHaveBeenLastCalledWith('rotated.token', { secret: 'old-secret-value' });
    expect(request.user).toEqual({ sub: 'rotated-user', permissions: ['p1'], permissionVersion: 0 });
  });

  it('rotation seam: still 401s when NEITHER current nor previous secret accepts the token', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = 'old-secret-value';
    const verifyAsync = jest
      .fn()
      .mockRejectedValueOnce(new Error('current rejects'))
      .mockRejectedValueOnce(new Error('previous rejects'));
    const guard = new JwtAuthGuard({ verifyAsync } as unknown as JwtService, makeReflector(false));
    const { context } = contextWith({ headers: { authorization: 'Bearer truly.bad' } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'Auth.TokenInvalid' },
    });
    expect(verifyAsync).toHaveBeenCalledTimes(2);
  });
});
