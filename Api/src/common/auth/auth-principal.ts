/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * The authenticated caller, derived from a verified access token. Attached to the
 * request by JwtAuthGuard and read by PermissionsGuard / @CurrentUser. `permissions` are the
 * principal's effective permission codes, baked into the JWT at login.
 */
export interface AuthPrincipal {
  sub: string;
  permissions: string[];
  // The user's permission-snapshot version at token-issue time (audit F9). PermissionsGuard compares it
  // against the user's current value and rejects a stale token, so RBAC changes apply before token TTL.
  permissionVersion: number;
}
