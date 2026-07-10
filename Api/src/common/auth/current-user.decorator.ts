/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Injects the authenticated principal (set by JwtAuthGuard) into a handler parameter.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal } from './auth-principal';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal =>
    ctx.switchToHttp().getRequest<FastifyRequest & { user: AuthPrincipal }>().user,
);
