/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Prisma client wired through the `@prisma/adapter-pg` driver adapter (Prisma 7).
 * The connection string comes from the environment (validated at boot) — never hardcoded.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertRuntimeRoleIsSafe();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * SEC-003 fail-closed boot guard: in PRODUCTION the runtime DB connection MUST be a non-superuser role.
   * A superuser (or the table owner) BYPASSES Row-Level Security, silently disabling the least-privilege +
   * RLS controls provisioned by `prisma/sql/db-security.sql` — so a superuser runtime is "RLS quietly off".
   * Probe `is_superuser` once at boot and refuse to start if it is on. Non-production is unchanged: dev/CI
   * connect as the superuser by design, so the probe is skipped (preserving the lazy-connect, boots-DB-down
   * behaviour). Never logs the connection string. Design: docs/security/rls-app-connection-design.md.
   */
  private async assertRuntimeRoleIsSafe(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') return;
    const rows = await this.$queryRaw<Array<{ is_superuser: string }>>`
      SELECT current_setting('is_superuser') AS is_superuser`;
    if (rows[0]?.is_superuser === 'on') {
      throw new Error(
        'Invalid runtime DB role — production must connect as a non-superuser role (a superuser bypasses ' +
          'Row-Level Security). Point DATABASE_URL at the least-privilege app_login role (member of app_rw) ' +
          'and run migrations via MIGRATE_DATABASE_URL. See docs/security/rls-app-connection-design.md.',
      );
    }
  }
}
