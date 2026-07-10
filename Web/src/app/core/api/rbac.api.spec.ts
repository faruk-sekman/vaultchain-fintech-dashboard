/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Seam test for RbacApi. Mocks ApiClientService (the same approach as
 * notification.api.spec.ts / mfa.api.spec.ts) and locks the contract for each list endpoint: the exact
 * path, and the `{ data: { items } }` (roles/permissions) vs `{ data }` (users) envelope unwrapping — so
 * the PII-minimal masked-email operator roster is returned as a flat array to the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, lastValueFrom } from 'rxjs';
import { ApiClientService } from './api-client.service';
import { RbacApi, RbacPermission, RbacRole, RbacUser } from './rbac.api';

const ROLES: RbacRole[] = [
  { id: 'r1', name: 'administrator', permissions: ['users.manage', 'auth.password.admin_reset'] },
  { id: 'r2', name: 'operator', permissions: ['customers.read'] },
];

const PERMISSIONS: RbacPermission[] = [
  { id: 'p1', code: 'users.manage' },
  { id: 'p2', code: 'auth.password.admin_reset' },
];

const USERS: RbacUser[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    displayName: 'Ops Operator',
    status: 'active',
    roles: ['operator'],
    emailMasked: 'o***@s***.local',
    locked: true,
    failedLoginCount: 5,
    lastLoginAt: '2026-06-20T08:00:00.000Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    displayName: 'Audit Auditor',
    status: 'active',
    roles: ['auditor'],
    emailMasked: 'a***@s***.local',
    locked: false,
    failedLoginCount: 0,
    lastLoginAt: null,
  },
];

describe('RbacApi', () => {
  let api: { get: ReturnType<typeof vi.fn> };
  let rbac: RbacApi;

  beforeEach(() => {
    api = { get: vi.fn() };
    TestBed.configureTestingModule({
      providers: [RbacApi, { provide: ApiClientService, useValue: api }],
    });
    rbac = TestBed.inject(RbacApi);
  });

  it('listRoles() GETs /roles and unwraps { data: { items } }', async () => {
    api.get.mockReturnValue(of({ data: { items: ROLES } }));

    const roles = await lastValueFrom(rbac.listRoles());

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/roles');
    expect(roles).toEqual(ROLES);
    expect(roles[0].permissions).toContain('users.manage');
  });

  it('listPermissions() GETs /permissions and unwraps { data: { items } }', async () => {
    api.get.mockReturnValue(of({ data: { items: PERMISSIONS } }));

    const permissions = await lastValueFrom(rbac.listPermissions());

    expect(api.get).toHaveBeenCalledWith('/permissions');
    expect(permissions).toEqual(PERMISSIONS);
    expect(permissions.map(p => p.code)).toEqual(['users.manage', 'auth.password.admin_reset']);
  });

  it('listUsers() GETs /users and unwraps the flat { data } array (masked-email roster)', async () => {
    api.get.mockReturnValue(of({ data: USERS }));

    const users = await lastValueFrom(rbac.listUsers());

    expect(api.get).toHaveBeenCalledWith('/users');
    expect(users).toEqual(USERS);
    // The email crosses the boundary already server-masked (never the raw address).
    expect(users[0].emailMasked).toBe('o***@s***.local');
    expect(users[0].locked).toBe(true);
    expect(users[1].lastLoginAt).toBeNull();
  });

  it('listUsers() passes an empty roster straight through (drives the manual-UUID fallback)', async () => {
    api.get.mockReturnValue(of({ data: [] as RbacUser[] }));

    const users = await lastValueFrom(rbac.listUsers());

    expect(users).toEqual([]);
  });
});
