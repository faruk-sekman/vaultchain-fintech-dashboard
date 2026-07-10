/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for RbacController (file-based ≥90% coverage round). RbacService mocked; no DB/HTTP.
 * Thin delegation layer — assert each route forwards exactly the right args (the controller unwraps
 * DTO fields like `dto.name` / `dto.permissionId` / `dto.roleId` and threads the actor) and passes
 * the return value through. The listUsers delegation forwards the raw query.
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { RbacController } from './rbac.controller';
import type { RbacService } from './rbac.service';
import type { AssignRoleDto, CreateRoleDto, GrantPermissionDto } from './dto/rbac.dto';

const actor = { sub: 'admin-1', permissions: ['roles.manage'] } as AuthPrincipal;
const ROLE_ID = '0190a0b0-0000-7000-8000-000000000001';
const PERM_ID = '0190a0b0-0000-7000-8000-000000000002';
const USER_ID = '0190a0b0-0000-7000-8000-000000000003';

function setup() {
  const service = {
    listRoles: jest.fn(),
    createRole: jest.fn(),
    listPermissions: jest.fn(),
    listUsers: jest.fn(),
    grantPermission: jest.fn(),
    revokePermission: jest.fn(),
    assignRole: jest.fn(),
    revokeRole: jest.fn(),
  };
  return { service, controller: new RbacController(service as unknown as RbacService) };
}

describe('RbacController', () => {
  it('listRoles delegates with no args', async () => {
    const { service, controller } = setup();
    const roles = [{ id: ROLE_ID }];
    service.listRoles.mockResolvedValue(roles);
    await expect(controller.listRoles()).resolves.toBe(roles);
    expect(service.listRoles).toHaveBeenCalledWith();
  });

  it('createRole unwraps dto.name and threads the actor (F10)', async () => {
    const { service, controller } = setup();
    const dto = { name: 'auditor' } as CreateRoleDto;
    const created = { id: ROLE_ID, name: 'auditor' };
    service.createRole.mockResolvedValue(created);
    await expect(controller.createRole(dto, actor)).resolves.toBe(created);
    expect(service.createRole).toHaveBeenCalledWith('auditor', actor);
  });

  it('listPermissions delegates with no args', async () => {
    const { service, controller } = setup();
    const perms = [{ id: PERM_ID }];
    service.listPermissions.mockResolvedValue(perms);
    await expect(controller.listPermissions()).resolves.toBe(perms);
    expect(service.listPermissions).toHaveBeenCalledWith();
  });

  it('listUsers forwards the raw query object', async () => {
    const { service, controller } = setup();
    const query = { 'page[number]': '2', 'filter[q]': 'ali' };
    const paged = { data: [], page: { number: 2, size: 25, totalItems: 0, totalPages: 1 } };
    service.listUsers.mockResolvedValue(paged);
    await expect(controller.listUsers(query)).resolves.toBe(paged);
    expect(service.listUsers).toHaveBeenCalledWith(query);
  });

  it('grantPermission forwards (roleId, dto.permissionId, actor)', async () => {
    const { service, controller } = setup();
    const dto = { permissionId: PERM_ID } as GrantPermissionDto;
    const result = { ok: true };
    service.grantPermission.mockResolvedValue(result);
    await expect(controller.grantPermission(ROLE_ID, dto, actor)).resolves.toBe(result);
    expect(service.grantPermission).toHaveBeenCalledWith(ROLE_ID, PERM_ID, actor);
  });

  it('revokePermission forwards (roleId, permissionId, actor)', async () => {
    const { service, controller } = setup();
    service.revokePermission.mockResolvedValue(undefined);
    await expect(controller.revokePermission(ROLE_ID, PERM_ID, actor)).resolves.toBeUndefined();
    expect(service.revokePermission).toHaveBeenCalledWith(ROLE_ID, PERM_ID, actor);
  });

  it('assignRole forwards (userId, dto.roleId, actor)', async () => {
    const { service, controller } = setup();
    const dto = { roleId: ROLE_ID } as AssignRoleDto;
    const result = { ok: true };
    service.assignRole.mockResolvedValue(result);
    await expect(controller.assignRole(USER_ID, dto, actor)).resolves.toBe(result);
    expect(service.assignRole).toHaveBeenCalledWith(USER_ID, ROLE_ID, actor);
  });

  it('revokeRole forwards (userId, roleId, actor)', async () => {
    const { service, controller } = setup();
    service.revokeRole.mockResolvedValue(undefined);
    await expect(controller.revokeRole(USER_ID, ROLE_ID, actor)).resolves.toBeUndefined();
    expect(service.revokeRole).toHaveBeenCalledWith(USER_ID, ROLE_ID, actor);
  });

  it('re-throws when the service rejects (e.g. self-escalation guard)', async () => {
    const { service, controller } = setup();
    const boom = new Error('self-escalation blocked');
    service.grantPermission.mockRejectedValue(boom);
    await expect(controller.grantPermission(ROLE_ID, { permissionId: PERM_ID } as GrantPermissionDto, actor)).rejects.toBe(boom);
  });
});
