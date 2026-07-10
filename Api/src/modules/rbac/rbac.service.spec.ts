/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for RbacService (audit 9C). Mocked Prisma + Audit. Covers the read paths plus every
 * guard branch: permission/role/user NotFound, the direct + indirect self-escalation DENIED paths,
 * and the audited success transactions. It also covers listUsers: the PII-minimal
 * projection (only id/displayName/status/roles), the pagination math, and the search filter.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RbacService } from './rbac.service';

function makeMocks(actorPerms: string[] = ['perm.a']) {
  const tx = {
    role: { create: jest.fn() },
    rolePermission: { upsert: jest.fn(), deleteMany: jest.fn() },
    userRole: { upsert: jest.fn(), deleteMany: jest.fn() },
    // count: ≥1 active admin by default → revoke invariant passes. update/updateMany: F9 token-version bump.
    user: { count: jest.fn().mockResolvedValue(1), update: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    role: { findMany: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    permission: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { findUnique: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    // Supports BOTH forms: a callback (mutation tx) and an array of promises (listUsers read).
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (t: unknown) => unknown)(tx),
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const actor = { sub: 'admin', permissions: actorPerms } as AuthPrincipal;
  const service = new RbacService(prisma as unknown as PrismaService, audit as unknown as AuditService);
  return { prisma, audit, actor, service, tx };
}

describe('RbacService', () => {
  it('listRoles maps roles with sorted permission codes', async () => {
    const { prisma, service } = makeMocks();
    prisma.role.findMany.mockResolvedValue([
      { id: 'r1', name: 'Admin', rolePermissions: [{ permission: { code: 'z.write' } }, { permission: { code: 'a.read' } }] },
    ]);
    await expect(service.listRoles()).resolves.toEqual({
      items: [{ id: 'r1', name: 'Admin', permissions: ['a.read', 'z.write'] }],
    });
  });

  it('createRole creates the role and audits role.create in the same transaction (F10)', async () => {
    const { service, actor, audit, tx } = makeMocks();
    tx.role.create.mockResolvedValue({ id: 'r2', name: 'Ops' });
    await expect(service.createRole('Ops', actor)).resolves.toEqual({ id: 'r2', name: 'Ops', permissions: [] });
    expect(tx.role.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.create', outcome: 'SUCCESS', resourceId: 'r2' }),
      tx,
    );
  });

  it('listPermissions maps the catalog', async () => {
    const { prisma, service } = makeMocks();
    prisma.permission.findMany.mockResolvedValue([{ id: 'p1', code: 'a.read' }]);
    await expect(service.listPermissions()).resolves.toEqual({ items: [{ id: 'p1', code: 'a.read' }] });
  });

  describe('listUsers', () => {
    it('projects id/displayName/status/roles + a MASKED email + lockout telemetry + page meta', async () => {
      const { prisma, service } = makeMocks();
      const lastLogin = new Date('2026-06-28T09:00:00.000Z');
      prisma.user.count.mockResolvedValue(2);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          displayName: 'Alice Admin',
          status: 'ACTIVE',
          email: 'alice.admin@acme.local',
          lastLoginAt: lastLogin,
          failedLoginCount: 0,
          lockedUntil: null,
          userRoles: [{ role: { name: 'operator' } }, { role: { name: 'administrator' } }],
        },
        {
          id: 'u2',
          displayName: null,
          status: 'LOCKED',
          email: 'bob@x.io',
          lastLoginAt: null,
          failedLoginCount: 5,
          lockedUntil: null,
          userRoles: [],
        },
      ]);

      const res = await service.listUsers({});

      expect(res.data).toEqual([
        {
          id: 'u1',
          displayName: 'Alice Admin',
          status: 'ACTIVE',
          roles: ['administrator', 'operator'],
          emailMasked: 'a***@a***.local',
          locked: false,
          failedLoginCount: 0,
          lastLoginAt: lastLogin.toISOString(),
        },
        {
          id: 'u2',
          displayName: null,
          status: 'LOCKED',
          roles: [],
          emailMasked: 'b***@x***.io',
          locked: true,
          failedLoginCount: 5,
          lastLoginAt: null,
        },
      ]);
      expect(res.page).toEqual({ number: 1, size: 25, totalItems: 2, totalPages: 1 });
      // The select stays an explicit allowlist — never password/secret; email is masked server-side.
      const selectArg = prisma.user.findMany.mock.calls[0][0].select;
      expect(Object.keys(selectArg).sort()).toEqual([
        'displayName',
        'email',
        'failedLoginCount',
        'id',
        'lastLoginAt',
        'lockedUntil',
        'status',
        'userRoles',
      ]);
      // Defensive: the RAW `email` key NEVER appears on a response row — only the masked form leaves.
      for (const row of res.data) {
        expect(Object.keys(row)).not.toContain('email');
        expect(Object.keys(row).sort()).toEqual([
          'displayName',
          'emailMasked',
          'failedLoginCount',
          'id',
          'lastLoginAt',
          'locked',
          'roles',
          'status',
        ]);
      }
    });

    it('computes totalPages from totalItems and size', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.count.mockResolvedValue(51);
      prisma.user.findMany.mockResolvedValue([]);
      const res = await service.listUsers({ 'page[number]': '2', 'page[size]': '25' });
      expect(res.page).toMatchObject({ number: 2, size: 25, totalItems: 51, totalPages: 3 });
      // skip = (page-1)*size
      expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({ skip: 25, take: 25 });
    });

    it('an empty table still reports totalPages = 1 (never 0)', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.count.mockResolvedValue(0);
      prisma.user.findMany.mockResolvedValue([]);
      const res = await service.listUsers({});
      expect(res.page).toMatchObject({ totalItems: 0, totalPages: 1 });
    });

    it('applies a case-insensitive displayName contains filter when filter[q] is present', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.count.mockResolvedValue(0);
      prisma.user.findMany.mockResolvedValue([]);
      await service.listUsers({ 'filter[q]': 'ali' });
      expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({
        where: { displayName: { contains: 'ali', mode: 'insensitive' } },
      });
    });

    it('uses an empty where (no filter) when filter[q] is absent', async () => {
      const { prisma, service } = makeMocks();
      prisma.user.count.mockResolvedValue(0);
      prisma.user.findMany.mockResolvedValue([]);
      await service.listUsers({});
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({});
    });

    it('rejects an out-of-range page[size] with a 400 (bounds bulk enumeration)', async () => {
      const { service } = makeMocks();
      await expect(service.listUsers({ 'page[size]': '101' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-numeric page[number] with a 400', async () => {
      const { service } = makeMocks();
      await expect(service.listUsers({ 'page[number]': 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    });

    // maskEmail edge cases — no raw PII may leave regardless of the address shape. Exercised through
    // listUsers (maskEmail is module-private), one degenerate address per row.
    it('masks degenerate email shapes without leaking the raw address', async () => {
      const { prisma, service } = makeMocks();
      const row = (id: string, email: string) => ({
        id,
        displayName: id,
        status: 'ACTIVE',
        email,
        lastLoginAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        userRoles: [],
      });
      prisma.user.count.mockResolvedValue(4);
      prisma.user.findMany.mockResolvedValue([
        row('no-at', 'no-at-sign'), //            no '@'            → '***'
        row('at-first', '@acme.local'), //        '@' at index 0    → '***'
        row('no-dot', 'carol@localhost'), //      domain w/o a dot  → local kept, whole host masked
        row('empty-domain', 'dave@'), //          '@' present but empty domain → host[0] ?? '*'
      ]);

      const res = await service.listUsers({});
      const masked = Object.fromEntries(res.data.map((r) => [r.id, r.emailMasked]));

      expect(masked['no-at']).toBe('***');
      expect(masked['at-first']).toBe('***');
      expect(masked['no-dot']).toBe('c***@l***'); // no dot → no trailing ".tld"
      expect(masked['empty-domain']).toBe('d***@****'); // host[0] undefined → '*' + '***' literal
      // Belt-and-braces: not one raw address survives masking.
      for (const raw of ['no-at-sign', '@acme.local', 'carol@localhost', 'dave@']) {
        expect(Object.values(masked)).not.toContain(raw);
      }
    });

    it('flags locked=true from a FUTURE lockedUntil even when status is not LOCKED', async () => {
      const { prisma, service } = makeMocks();
      const future = new Date(Date.now() + 60 * 60 * 1000); // lockout still in effect
      const past = new Date(Date.now() - 60 * 60 * 1000); //   lockout already expired
      prisma.user.count.mockResolvedValue(2);
      prisma.user.findMany.mockResolvedValue([
        { id: 'temp-locked', displayName: 'Temp', status: 'ACTIVE', email: 'temp@acme.local', lastLoginAt: null, failedLoginCount: 3, lockedUntil: future, userRoles: [] },
        { id: 'expired', displayName: 'Free', status: 'ACTIVE', email: 'free@acme.local', lastLoginAt: null, failedLoginCount: 0, lockedUntil: past, userRoles: [] },
      ]);

      const res = await service.listUsers({});
      const locked = Object.fromEntries(res.data.map((r) => [r.id, r.locked]));
      expect(locked['temp-locked']).toBe(true); //  ACTIVE + future lockedUntil → locked
      expect(locked['expired']).toBe(false); //      ACTIVE + past   lockedUntil → not locked
    });
  });

  describe('grantPermission', () => {
    it('throws NotFound when the permission does not exist', async () => {
      const { prisma, service, actor } = makeMocks();
      prisma.permission.findUnique.mockResolvedValue(null);
      await expect(service.grantPermission('r1', 'p1', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('DENIES + audits when the actor does not hold the permission (self-escalation)', async () => {
      const { prisma, audit, service, actor } = makeMocks(['other']);
      prisma.permission.findUnique.mockResolvedValue({ id: 'p1', code: 'a.read' });
      await expect(service.grantPermission('r1', 'p1', actor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DENIED' }));
    });

    it('throws NotFound when the role does not exist', async () => {
      const { prisma, service, actor } = makeMocks(['a.read']);
      prisma.permission.findUnique.mockResolvedValue({ id: 'p1', code: 'a.read' });
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.grantPermission('r1', 'p1', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upserts + audits SUCCESS on a held permission', async () => {
      const { prisma, audit, service, actor, tx } = makeMocks(['a.read']);
      prisma.permission.findUnique.mockResolvedValue({ id: 'p1', code: 'a.read' });
      prisma.role.findUnique.mockResolvedValue({ id: 'r1' });
      await expect(service.grantPermission('r1', 'p1', actor)).resolves.toEqual({ roleId: 'r1', code: 'a.read' });
      expect(tx.rolePermission.upsert).toHaveBeenCalled();
      // F9: everyone holding the role has their outstanding tokens invalidated (version bump).
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { userRoles: { some: { roleId: 'r1' } } },
        data: { permissionVersion: { increment: 1 } },
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }), tx);
    });
  });

  it('revokePermission deletes + audits in a transaction', async () => {
    const { service, actor, tx, audit } = makeMocks();
    await service.revokePermission('r1', 'p1', actor);
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r1', permissionId: 'p1' } });
    // F9: everyone holding the role has their outstanding tokens invalidated (version bump).
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { userRoles: { some: { roleId: 'r1' } } },
      data: { permissionVersion: { increment: 1 } },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'role.revoke_permission' }), tx);
  });

  describe('assignRole', () => {
    it('throws NotFound when the role does not exist', async () => {
      const { prisma, service, actor } = makeMocks();
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.assignRole('u1', 'r1', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('DENIES indirect self-escalation when the role grants a permission the actor lacks', async () => {
      const { prisma, audit, service, actor } = makeMocks(['a.read']);
      prisma.role.findUnique.mockResolvedValue({ id: 'r1', rolePermissions: [{ permission: { code: 'b.write' } }] });
      await expect(service.assignRole('u1', 'r1', actor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DENIED' }));
    });

    it('throws NotFound when the user does not exist', async () => {
      const { prisma, service, actor } = makeMocks(['a.read']);
      prisma.role.findUnique.mockResolvedValue({ id: 'r1', rolePermissions: [{ permission: { code: 'a.read' } }] });
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.assignRole('u1', 'r1', actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upserts + audits SUCCESS when all role permissions are held', async () => {
      const { prisma, audit, service, actor, tx } = makeMocks(['a.read']);
      prisma.role.findUnique.mockResolvedValue({ id: 'r1', rolePermissions: [{ permission: { code: 'a.read' } }] });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1' });
      await expect(service.assignRole('u1', 'r1', actor)).resolves.toEqual({ userId: 'u1', roleId: 'r1' });
      expect(tx.userRole.upsert).toHaveBeenCalled();
      // F9: the assigned user's outstanding tokens are invalidated (version bump).
      expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { permissionVersion: { increment: 1 } } });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }), tx);
    });
  });

  it('revokeRole deletes + audits in a transaction', async () => {
    const { service, actor, tx, audit } = makeMocks();
    await service.revokeRole('u1', 'r1', actor);
    expect(tx.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', roleId: 'r1' } });
    // F9: the affected user's outstanding tokens are invalidated (version bump).
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { permissionVersion: { increment: 1 } } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.revoke_role' }), tx);
  });

  describe('last-admin invariant (F11)', () => {
    it('BLOCKS revokePermission that would drop the last admin capability + audits DENIED', async () => {
      const { service, actor, tx, audit } = makeMocks();
      tx.user.count.mockResolvedValue(0); // after the delete, zero active holders of a critical capability
      await expect(service.revokePermission('r1', 'p1', actor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role.revoke_permission', outcome: 'DENIED', context: expect.objectContaining({ reason: 'last_admin' }) }),
      );
    });

    it('BLOCKS revokeRole that would drop the last admin capability + audits DENIED', async () => {
      const { service, actor, tx, audit } = makeMocks();
      tx.user.count.mockResolvedValue(0);
      await expect(service.revokeRole('u1', 'r1', actor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.revoke_role', outcome: 'DENIED', context: expect.objectContaining({ reason: 'last_admin' }) }),
      );
    });

    it('ALLOWS a revoke while another active admin remains (holders > 0)', async () => {
      const { service, actor, tx, audit } = makeMocks(); // default tx.user.count → 1
      await expect(service.revokeRole('u1', 'r1', actor)).resolves.toBeUndefined();
      expect(tx.userRole.deleteMany).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.revoke_role', outcome: 'SUCCESS' }), tx);
    });
  });
});
