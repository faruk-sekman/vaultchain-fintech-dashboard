/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Authorization guard: allows the request only if the principal holds EVERY required
 * permission code (declared via @RequirePermissions). Fail-closed — no/insufficient permissions is
 * `403`. Runs after JwtAuthGuard, which populates `request.user`.
 *
 * Token-staleness gate (audit F9, CWE-613/CWE-269): access tokens embed the permissionVersion they were
 * minted with. Once the in-token permissions would authorize the request, the guard re-reads the user's
 * CURRENT permissionVersion; a mismatch means an RBAC change has invalidated the token's snapshot, so it
 * is rejected `401` (re-authenticate) instead of trusted until its TTL expires. The lookup runs only for
 * otherwise-authorized requests, so denied requests never pay for it.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal } from './auth-principal';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthPrincipal }>();
    const principal = request.user;
    const granted = new Set(principal?.permissions ?? []);
    if (!principal || !required.every((permission) => granted.has(permission))) {
      throw new ForbiddenException({
        code: 'Auth.Forbidden',
        message: 'You do not have the required permission for this resource.',
      });
    }

    // Token-staleness gate (audit F9): the in-token permissions authorize this request, but the token
    // carries the permissionVersion it was minted with. Re-read the user's CURRENT version and reject a
    // stale snapshot, so a role/permission change (which bumps the version) applies immediately instead
    // of lingering until the token TTL. Runs only for otherwise-authorized requests.
    const current = await this.prisma.user.findUnique({
      where: { id: principal.sub },
      select: { permissionVersion: true },
    });
    if (!current || current.permissionVersion !== principal.permissionVersion) {
      throw new UnauthorizedException({
        code: 'Auth.PermissionsStale',
        message: 'Your access has changed; please sign in again.',
      });
    }
    return true;
  }
}
