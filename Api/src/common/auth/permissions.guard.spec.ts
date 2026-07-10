/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PermissionsGuard (least-privilege). Covers: no-metadata / empty-metadata
 * allow branches, the every()-required deny branch, the all-granted allow branch, the missing-user
 * (no principal) fail-closed branch, and the multi-permission partial-grant deny. Plus the audit-F9
 * token-staleness gate: a would-authorize token is re-validated against the user's CURRENT
 * permissionVersion and rejected 401 if stale; denied requests skip the version lookup. Hermetic mocks.
 */
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { PermissionsGuard } from './permissions.guard';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

type Principal = { sub: string; permissions: string[]; permissionVersion: number };
type AuthRequest = FastifyRequest & { user?: Principal };

function contextWith(user: AuthRequest['user']): ExecutionContext {
  const req = { user } as AuthRequest;
  return {
    getHandler: () => (): void => undefined,
    getClass: () => (): void => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeReflector(required: string[] | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
}

/** Prisma stub whose user.findUnique returns the given CURRENT permissionVersion (null = user gone). */
function makePrisma(currentVersion: number | null): PrismaService {
  return {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(currentVersion === null ? null : { permissionVersion: currentVersion }),
    },
  } as unknown as PrismaService;
}

describe('PermissionsGuard', () => {
  it('allows when no @RequirePermissions metadata is present (undefined)', async () => {
    const reflector = makeReflector(undefined);
    const guard = new PermissionsGuard(reflector, makePrisma(0));

    await expect(
      guard.canActivate(contextWith({ sub: 'u', permissions: [], permissionVersion: 0 })),
    ).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(PERMISSIONS_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it('allows when the required-permissions list is empty', async () => {
    const guard = new PermissionsGuard(makeReflector([]), makePrisma(0));
    await expect(
      guard.canActivate(contextWith({ sub: 'u', permissions: [], permissionVersion: 0 })),
    ).resolves.toBe(true);
  });

  it('allows when the principal holds the single required permission and the version is current', async () => {
    const guard = new PermissionsGuard(makeReflector(['customers.read']), makePrisma(3));
    await expect(
      guard.canActivate(contextWith({ sub: 'u', permissions: ['customers.read'], permissionVersion: 3 })),
    ).resolves.toBe(true);
  });

  it('allows when the principal holds EVERY required permission (superset is fine)', async () => {
    const guard = new PermissionsGuard(makeReflector(['customers.read', 'customers.update']), makePrisma(0));
    const ctx = contextWith({
      sub: 'u',
      permissions: ['customers.read', 'customers.update', 'customers.delete'],
      permissionVersion: 0,
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('denies (403 Auth.Forbidden) when the principal is missing a required permission', async () => {
    const guard = new PermissionsGuard(makeReflector(['customers.read', 'customers.update']), makePrisma(0));
    const ctx = contextWith({ sub: 'u', permissions: ['customers.read'], permissionVersion: 0 }); // update missing

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'Auth.Forbidden' } });
  });

  it('fail-closed: denies when there is no authenticated principal on the request', async () => {
    const guard = new PermissionsGuard(makeReflector(['customers.read']), makePrisma(0));
    await expect(guard.canActivate(contextWith(undefined))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fail-closed: denies when the principal has an empty permission set', async () => {
    const guard = new PermissionsGuard(makeReflector(['customers.read']), makePrisma(0));
    await expect(
      guard.canActivate(contextWith({ sub: 'u', permissions: [], permissionVersion: 0 })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('audit F9 — token-staleness gate', () => {
    it('rejects a token whose permissionVersion is STALE (an RBAC change bumped it) with 401', async () => {
      // The token authorizes on its claims, but the user's current version has moved on (2 → 5).
      const guard = new PermissionsGuard(makeReflector(['customers.read']), makePrisma(5));
      const ctx = contextWith({ sub: 'u', permissions: ['customers.read'], permissionVersion: 2 });

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'Auth.PermissionsStale' } });
    });

    it('rejects with 401 when the user no longer exists (findUnique → null)', async () => {
      const guard = new PermissionsGuard(makeReflector(['customers.read']), makePrisma(null));
      const ctx = contextWith({ sub: 'gone', permissions: ['customers.read'], permissionVersion: 0 });

      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ response: { code: 'Auth.PermissionsStale' } });
    });

    it('does NOT read the DB when the permission check already fails (denied requests skip the lookup)', async () => {
      const findUnique = jest.fn().mockResolvedValue({ permissionVersion: 0 });
      const prisma = { user: { findUnique } } as unknown as PrismaService;
      const guard = new PermissionsGuard(makeReflector(['customers.update']), prisma);
      const ctx = contextWith({ sub: 'u', permissions: ['customers.read'], permissionVersion: 0 }); // update missing

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
