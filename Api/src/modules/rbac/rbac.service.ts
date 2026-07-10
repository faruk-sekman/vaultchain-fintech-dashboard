/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * RBAC administration: read/manage roles, the permission catalog, and
 * role↔permission / user↔role assignments. Server-side **self-escalation guard** — an actor may
 * not grant a permission (directly, or via a role) that they do not themselves hold. Every mutation
 * appends to the tamper-evident audit chain: SUCCESS rows are written inside the
 * mutation transaction (fail-closed); DENIED rows are written standalone so the throw keeps them.
 *
 * Effective permissions for the self-escalation check come from the caller's verified JWT, the same
 * source the route guard trusts (consistent stale-tolerance ≤ token TTL).
 *
 * An admin-only paged `listUsers()` serves the admin password-reset operator picker:
 * id/displayName/status/roles plus a MASKED email + lockout telemetry (locked/failedLoginCount/
 * lastLoginAt) for the operator-status panel. `maskEmail` runs server-side so NO raw email/secret ever
 * leaves; enumeration is bounded by the query parser's max page size.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuditService } from '../../common/audit/audit.service';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PaginatedUserListDto } from './dto/user-list.dto';
import { parseUserListQuery } from './user-list.query';

/**
 * Mask an email server-side so no raw PII ever leaves the service (the operator picker only ever
 * receives the masked form): `mert.kaya@acme.local` → `m***@a***.local`.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const rest = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${host[0] ?? '*'}***${rest}`;
}

@Injectable()
export class RbacService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listRoles(): Promise<{ items: Array<{ id: string; name: string; permissions: string[] }> }> {
    const roles = await this.prisma.role.findMany({
      include: { rolePermissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
    return {
      items: roles.map((role) => ({
        id: role.id,
        name: role.name,
        permissions: role.rolePermissions.map((rp) => rp.permission.code).sort(),
      })),
    };
  }

  /**
   * Admin-only paged user list. Projection — id, displayName, status, role names, a
   * MASKED email, and the lockout telemetry the operator-status panel needs (locked / failedLoginCount
   * / lastLoginAt). NEVER password/secret or a RAW email — `maskEmail` runs server-side so no raw PII
   * leaves. Ordered by the UUIDv7 id (stable, time-ordered); `page[size]` is bounded by the parser, so a
   * caller cannot bulk-enumerate the table in one request.
   */
  async listUsers(query: Record<string, unknown>): Promise<PaginatedUserListDto> {
    const { page, size, q } = parseUserListQuery(query);
    const where: Prisma.UserWhereInput = q
      ? { displayName: { contains: q, mode: 'insensitive' } }
      : {};

    const [totalItems, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { id: 'asc' }, // UUIDv7 → creation-ordered + stable for pagination
        skip: (page - 1) * size,
        take: size,
        // Allowlist select — the email is masked server-side (below) so no RAW PII leaves the DB row.
        select: {
          id: true,
          displayName: true,
          status: true,
          email: true,
          lastLoginAt: true,
          failedLoginCount: true,
          lockedUntil: true,
          userRoles: { select: { role: { select: { name: true } } } },
        },
      }),
    ]);

    const now = new Date();
    return {
      data: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        status: row.status,
        roles: row.userRoles.map((ur) => ur.role.name).sort(),
        emailMasked: maskEmail(row.email),
        locked: row.status === 'LOCKED' || (row.lockedUntil !== null && row.lockedUntil > now),
        failedLoginCount: row.failedLoginCount,
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      })),
      page: {
        number: page,
        size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / size)),
      },
    };
  }

  async createRole(name: string, actor: AuthPrincipal): Promise<{ id: string; name: string; permissions: string[] }> {
    // F10 (CWE-778): create the role and its audit record atomically — every RBAC mutation must leave a
    // durable actor trail on the tamper-evident chain (matches grant/assign; createRole was the outlier).
    const role = await this.prisma.$transaction(async (tx) => {
      const created = await tx.role.create({ data: { id: uuidv7(), name } });
      await this.audit.record(
        { actorUserId: actor.sub, action: 'role.create', resourceType: 'role', resourceId: created.id, outcome: 'SUCCESS', context: { name } },
        tx,
      );
      return created;
    });
    return { id: role.id, name: role.name, permissions: [] };
  }

  async listPermissions(): Promise<{ items: Array<{ id: string; code: string }> }> {
    const permissions = await this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
    return { items: permissions.map((p) => ({ id: p.id, code: p.code })) };
  }

  async grantPermission(roleId: string, permissionId: string, actor: AuthPrincipal): Promise<{ roleId: string; code: string }> {
    const permission = await this.prisma.permission.findUnique({ where: { id: permissionId } });
    if (!permission) throw new NotFoundException({ code: 'Rbac.PermissionNotFound', message: 'Permission not found.' });

    if (!actor.permissions.includes(permission.code)) {
      await this.audit.record({ actorUserId: actor.sub, action: 'role.grant_permission', resourceType: 'role', resourceId: roleId, outcome: 'DENIED', context: { permission: permission.code } });
      throw new ForbiddenException({ code: 'Rbac.SelfEscalation', message: 'You cannot grant a permission you do not hold.' });
    }
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException({ code: 'Rbac.RoleNotFound', message: 'Role not found.' });

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId },
        update: {},
      });
      // F9: the role's permission set changed → invalidate outstanding tokens of everyone holding the role.
      await tx.user.updateMany({ where: { userRoles: { some: { roleId } } }, data: { permissionVersion: { increment: 1 } } });
      await this.audit.record({ actorUserId: actor.sub, action: 'role.grant_permission', resourceType: 'role', resourceId: roleId, outcome: 'SUCCESS', context: { permission: permission.code } }, tx);
    });
    return { roleId, code: permission.code };
  }

  /**
   * RBAC capabilities whose LAST active holder must never be revoked (F11) — losing either one leaves no
   * operator able to re-administer RBAC: `permissions.manage` (grant/revoke permissions) and
   * `users.manage` (assign/revoke roles).
   */
  private static readonly CRITICAL_ADMIN_PERMISSIONS = ['permissions.manage', 'users.manage'];

  /**
   * Governance invariant (F11 / CWE-284): after a revoke has been applied inside `tx`, refuse to leave
   * ZERO active users holding a critical admin capability. Throwing here rolls the surrounding
   * transaction back, so the revoke is undone.
   */
  private async assertAdminSurvives(tx: Prisma.TransactionClient): Promise<void> {
    for (const code of RbacService.CRITICAL_ADMIN_PERMISSIONS) {
      const holders = await tx.user.count({
        where: { status: 'ACTIVE', userRoles: { some: { role: { rolePermissions: { some: { permission: { code } } } } } } },
      });
      if (holders === 0) {
        throw new ForbiddenException({
          code: 'Rbac.LastAdmin',
          message: 'This change would remove the last administrator capability and is not allowed.',
        });
      }
    }
  }

  // De-escalation (revoke) is gated by permissions.manage / users.manage and every revoke is audited.
  // F11: a revoke must never remove the LAST active holder of a critical admin capability (that would
  // lock every operator out of RBAC recovery). The invariant runs INSIDE the mutation transaction — the
  // delete is applied, then assertAdminSurvives re-counts holders and throws (rolling the delete back)
  // if none remain; a blocked attempt is audited DENIED.
  async revokePermission(roleId: string, permissionId: string, actor: AuthPrincipal): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.rolePermission.deleteMany({ where: { roleId, permissionId } });
        await this.assertAdminSurvives(tx);
        // F9: the role's permission set changed → invalidate outstanding tokens of everyone holding the role.
        await tx.user.updateMany({ where: { userRoles: { some: { roleId } } }, data: { permissionVersion: { increment: 1 } } });
        await this.audit.record({ actorUserId: actor.sub, action: 'role.revoke_permission', resourceType: 'role', resourceId: roleId, outcome: 'SUCCESS', context: { permissionId } }, tx);
      });
    } catch (err) {
      if (err instanceof ForbiddenException) {
        await this.audit.record({ actorUserId: actor.sub, action: 'role.revoke_permission', resourceType: 'role', resourceId: roleId, outcome: 'DENIED', context: { permissionId, reason: 'last_admin' } });
      }
      throw err;
    }
  }

  async assignRole(userId: string, roleId: string, actor: AuthPrincipal): Promise<{ userId: string; roleId: string }> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (!role) throw new NotFoundException({ code: 'Rbac.RoleNotFound', message: 'Role not found.' });

    // Assigning a role grants its permissions — block indirect self-escalation.
    const missing = role.rolePermissions.map((rp) => rp.permission.code).filter((code) => !actor.permissions.includes(code));
    if (missing.length > 0) {
      await this.audit.record({ actorUserId: actor.sub, action: 'user.assign_role', resourceType: 'user', resourceId: userId, outcome: 'DENIED', context: { roleId, missing } });
      throw new ForbiddenException({ code: 'Rbac.SelfEscalation', message: 'You cannot assign a role granting permissions you do not hold.' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'Rbac.UserNotFound', message: 'User not found.' });

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId } },
        create: { userId, roleId },
        update: {},
      });
      // F9: this user's role set changed → invalidate their outstanding tokens (stale permission snapshot).
      await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } } });
      await this.audit.record({ actorUserId: actor.sub, action: 'user.assign_role', resourceType: 'user', resourceId: userId, outcome: 'SUCCESS', context: { roleId } }, tx);
    });
    return { userId, roleId };
  }

  async revokeRole(userId: string, roleId: string, actor: AuthPrincipal): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.userRole.deleteMany({ where: { userId, roleId } });
        await this.assertAdminSurvives(tx);
        // F9: this user's role set changed → invalidate their outstanding tokens (stale permission snapshot).
        await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } } });
        await this.audit.record({ actorUserId: actor.sub, action: 'user.revoke_role', resourceType: 'user', resourceId: userId, outcome: 'SUCCESS', context: { roleId } }, tx);
      });
    } catch (err) {
      if (err instanceof ForbiddenException) {
        await this.audit.record({ actorUserId: actor.sub, action: 'user.revoke_role', resourceType: 'user', resourceId: userId, outcome: 'DENIED', context: { roleId, reason: 'last_admin' } });
      }
      throw err;
    }
  }
}
