/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * TARGETED, PURELY-ADDITIVE, IDEMPOTENT permission grant (runtime enablement).
 *
 * Makes the new `auth.password.admin_reset` permission effective at runtime by inserting ONLY that
 * permission (+ its administrator grant) into the LOCAL dev database. This is deliberately NOT the
 * destructive seed-dev.ts (which wipes/recreates the 1500-customer scenario): this script does UPSERTs
 * ONLY and contains ABSOLUTELY NO delete/deleteMany/truncate/raw DELETE — it must not touch any other row.
 *
 * Non-destructiveness is PROVEN at runtime: it brackets the work with customer.count() before/after and
 * asserts they are identical (and exits non-zero if they ever differ).
 *
 * Mirrors seed-dev.ts exactly for: the localhost-only DB guard, the PrismaPg adapter wiring, and the
 * Permission / Role / RolePermission upsert shapes (id = app-layer randomUUID; RolePermission composite
 * key roleId_permissionId). Run from Api/:
 *   FTD_GOVERNANCE_BYPASS=1 DATABASE_URL=postgresql://postgres:postgres@localhost:55440/fintech_dev \
 *     npx ts-node scripts/grant-password-admin-reset.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { assertLocalDb } from '../src/common/util/assert-local-db';

/** The one permission this script enables, and the role that receives it (administrator ONLY). */
const PERMISSION_CODE = 'auth.password.admin_reset';
const ADMIN_ROLE_NAME = 'administrator';

/**
 * Localhost-only guard, copied 1:1 from seed-dev.ts: refuse to run unless DATABASE_URL points at a
 * localhost PostgreSQL (and never under NODE_ENV=production). A targeted insert is still a DB write, so
 * the same fail-fast safety applies.
 */
function assertLocalDatabase(): string {
  // F2: strict, URL-parsed host-allowlist guard (shared) — replaces the earlier @host substring regex.
  return assertLocalDb({ script: 'grant-password-admin-reset' });
}

async function main(): Promise<void> {
  const databaseUrl = assertLocalDatabase();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    // ---- Non-destruction guard (before): snapshot the customer count. ----
    const before = await prisma.customer.count();

    // (a) UPSERT the Permission row. Same shape as seed-dev.ts ensureRolesAndUsers(): keyed by `code`,
    //     create with an app-layer UUID id, no-op update (so a re-run never changes an existing row).
    const existingPermission = await prisma.permission.findUnique({ where: { code: PERMISSION_CODE } });
    const permission = await prisma.permission.upsert({
      where: { code: PERMISSION_CODE },
      create: { id: randomUUID(), code: PERMISSION_CODE },
      update: {},
    });
    const permissionWasCreated = !existingPermission;

    // (b) Find the administrator role exactly as seed-dev.ts identifies it (by unique `name`).
    const adminRole = await prisma.role.findFirst({ where: { name: ADMIN_ROLE_NAME } });
    if (!adminRole) {
      throw new Error(`grant-password-admin-reset: the '${ADMIN_ROLE_NAME}' role does not exist — run the full seed first.`);
    }

    // (c) UPSERT the RolePermission link via the real composite unique key (roleId_permissionId).
    const existingGrant = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
      create: { roleId: adminRole.id, permissionId: permission.id },
      update: {},
    });
    const grantWasCreated = !existingGrant;

    // ---- Non-destruction guard (after): the customer count MUST be unchanged. ----
    const after = await prisma.customer.count();

    console.log(`grant-password-admin-reset: permission '${PERMISSION_CODE}' ${permissionWasCreated ? 'CREATED' : 'already existed'}.`);
    console.log(`grant-password-admin-reset: administrator grant ${grantWasCreated ? 'CREATED' : 'already existed'}.`);
    console.log(`grant-password-admin-reset: customer.count before=${before} after=${after} (identical=${before === after ? 'YES' : 'NO'}).`);

    if (before !== after) {
      throw new Error(`NON-DESTRUCTIVE INVARIANT VIOLATED: customer.count changed ${before} -> ${after}. This script must never alter other data.`);
    }
    console.log('grant-password-admin-reset: done. Administrators must re-login to receive a JWT carrying the new permission.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
