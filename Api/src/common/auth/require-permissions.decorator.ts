/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Declares the permission code(s) a route (or controller) requires. PermissionsGuard reads this
 * and denies (403) unless the principal holds ALL of them (least-privilege enforcement).
 */
import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
