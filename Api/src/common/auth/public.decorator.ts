/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Marks a route as public so JwtAuthGuard skips it. Guards are applied per-controller here, so
 * this is mainly a safety net if the JWT guard is ever promoted to a global APP_GUARD.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
