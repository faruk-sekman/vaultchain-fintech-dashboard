/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';

export interface RbacRole {
  id: string;
  name: string;
  permissions: string[];
}

export interface RbacPermission {
  id: string;
  code: string;
}

/**
 * One operator row from the admin-only `GET /users` list. A LOCAL,
 * PII-minimal contract typed by hand (the regenerated `api-types` are not consumed here yet) and
 * mirroring the backend allowlist exactly — id, a display name, the lifecycle status, role codes, and
 * the lock/sign-in telemetry the backend now exposes for the reset screen. The email is delivered
 * already-masked by the server (`emailMasked`, e.g. "m***@s***.local"); no raw email/phone/national-id
 * crosses this boundary — the screen only identifies a target and shows whether it is locked.
 */
export interface RbacUser {
  id: string;
  displayName: string;
  status: string;
  roles: string[];
  /** Server-masked email (e.g. "m***@s***.local"); never the raw address — safe to render. */
  emailMasked: string;
  /** True when the account is locked out (failed-login lock) — drives the "Kilitli" badge. */
  locked: boolean;
  /** Count of consecutive failed sign-in attempts (drives "{{count}} deneme"). */
  failedLoginCount: number;
  /** ISO timestamp of the last successful sign-in, or null if the operator has never signed in. */
  lastLoginAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class RbacApi {
  constructor(private readonly api: ApiClientService) {}

  listRoles(): Observable<RbacRole[]> {
    return this.api
      .get<{ data: { items: RbacRole[] } }>('/roles')
      .pipe(map(response => response.data.items));
  }

  listPermissions(): Observable<RbacPermission[]> {
    return this.api
      .get<{ data: { items: RbacPermission[] } }>('/permissions')
      .pipe(map(response => response.data.items));
  }

  /**
   * Admin-only operator list for the password-reset picker. The backend gates it on
   * `users.manage` (separation of duties — NOT `auth.password.admin_reset`) and bounds the page size
   * server-side. The envelope is `{ data: RbacUser[], page }`; we unwrap `data` (the picker loads the
   * first page of operators — a small fixed roster — and does not paginate). A 403 (no `users.manage`)
   * surfaces to the caller, which falls back to the manual UUID field.
   */
  listUsers(): Observable<RbacUser[]> {
    return this.api.get<{ data: RbacUser[] }>('/users').pipe(map(response => response.data));
  }
}
