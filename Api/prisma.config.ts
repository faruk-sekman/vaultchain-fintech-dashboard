/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Prisma 7 CLI config (replaces the datasource `url` in schema.prisma). The connection
 * URL is read from the environment — never hardcoded, never committed (see .env.example).
 * The runtime PrismaClient connects via the `@prisma/adapter-pg` driver adapter.
 */
import { defineConfig } from 'prisma/config';
import { existsSync } from 'node:fs';

// Make Prisma CLI commands that CONNECT (migrate, studio) see DATABASE_URL the same way the
// runtime ConfigModule does: when it isn't already exported, load it from Api/.env (resolved from the
// Api/ working dir the CLI runs in). An explicit `export DATABASE_URL=...` still wins; `generate` does
// not connect, so a missing .env stays non-fatal (the url falls back to '' below).
if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

// Read directly from the environment (not the strict `env()` helper) so `prisma generate`
// — which does not connect — works without DATABASE_URL set (e.g. fresh install / build).
// Commands that DO connect (migrate deploy, migrate dev) require a real DATABASE_URL or fail clearly.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
