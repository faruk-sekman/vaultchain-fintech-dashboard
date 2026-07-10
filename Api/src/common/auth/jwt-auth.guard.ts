/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Authentication guard: requires a valid `Authorization: Bearer <jwt>` and attaches the
 * verified principal to the request. Fail-closed — any missing/invalid/expired token is `401`.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal } from './auth-principal';
import { IS_PUBLIC_KEY } from './public.decorator';
import { verifyWithRotation } from './jwt-rotation';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthPrincipal }>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      throw new UnauthorizedException({
        code: 'Auth.TokenMissing',
        message: 'A Bearer access token is required.',
      });
    }

    try {
      // Verify against the current access secret, falling back to JWT_ACCESS_SECRET_PREVIOUS during a
      // key rotation (no fallback configured → current-secret-only, unchanged).
      const payload = await verifyWithRotation<{ sub: string; permissions?: string[]; pv?: number }>(
        this.jwt,
        token,
      );
      request.user = {
        sub: payload.sub,
        permissions: payload.permissions ?? [],
        permissionVersion: payload.pv ?? 0,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        code: 'Auth.TokenInvalid',
        message: 'The access token is invalid or expired.',
      });
    }
  }
}
