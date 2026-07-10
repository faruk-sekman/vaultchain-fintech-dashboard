#!/usr/bin/env node
/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Applies the committed migrations under prisma/migrations to DATABASE_URL.
 *
 * `prisma migrate deploy` refuses with P3005 when the target database already carries the schema
 * but has no `_prisma_migrations` ledger. That is the exact state of every database provisioned by
 * the `prisma db push` flow this project used before migrations existed. Dropping the operator's
 * data to satisfy the tool would be the wrong trade, so those databases are baselined instead: the
 * migrations already represented by the live schema are marked as applied, then deploy runs again.
 *
 * A genuinely fresh database never reaches the fallback — the first deploy creates the schema.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(apiRoot, 'prisma', 'migrations');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const prisma = args => spawnSync(npx, ['prisma', ...args], { cwd: apiRoot, encoding: 'utf8' });

/** Committed migration directories, in the order Prisma applies them. */
const migrationNames = () =>
  existsSync(migrationsDir)
    ? readdirSync(migrationsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(migrationsDir, entry.name, 'migration.sql')))
        .map(entry => entry.name)
        .sort()
    : [];

const forward = result => {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
};

const fail = result => {
  forward(result);
  process.exit(result.status ?? 1);
};

const firstDeploy = prisma(['migrate', 'deploy']);
if (firstDeploy.status === 0) {
  forward(firstDeploy);
  process.exit(0);
}

// Only P3005 ("the database schema is not empty") is recoverable; anything else is a real failure.
if (!`${firstDeploy.stdout ?? ''}${firstDeploy.stderr ?? ''}`.includes('P3005')) fail(firstDeploy);

// Baselining asserts "the live schema already IS these migrations", so prove it before claiming it —
// silently marking a drifted database as up to date would hide the drift until a query failed at
// runtime.
//
// The check is one-directional on purpose. `migrate diff` renders the SQL that would carry the live
// database TO schema.prisma, and a healthy database legitimately holds objects the schema never
// declares: the `integrity.sql` constraints and the `metric_daily` analytics rollup. Those surface
// as DROP statements and are fine. What is NOT fine is the database MISSING something the schema
// requires — that renders as a CREATE, an ADD, or a column alteration.
const diff = prisma(['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script']);
if (diff.status !== 0) fail(diff);

const statements = (diff.stdout ?? '')
  .split('\n')
  .filter(line => line.trim() && !line.trim().startsWith('--'))
  .join('\n');
const MISSING_FROM_DATABASE =
  /\b(CREATE\s+(TABLE|TYPE|SCHEMA|SEQUENCE|(UNIQUE\s+)?INDEX)|ADD\s+(COLUMN|CONSTRAINT|VALUE)|ALTER\s+COLUMN)\b/i;

if (MISSING_FROM_DATABASE.test(statements)) {
  process.stderr.write(
    'db-deploy: this database predates the migrations directory and is missing objects that\n' +
      'prisma/schema.prisma requires, so it cannot be baselined safely. Rebuild it with\n' +
      '`npm run db:reset` (from the repo root — destroys and reseeds the dev database), or\n' +
      'reconcile it by hand. The gap:\n\n' +
      statements +
      '\n\n',
  );
  process.exit(1);
}

console.log('db-deploy: schema present without a migration history — baselining this database.');
for (const name of migrationNames()) {
  const resolved = prisma(['migrate', 'resolve', '--applied', name]);
  if (resolved.status !== 0) fail(resolved);
  console.log(`db-deploy: marked ${name} as already applied.`);
}

const secondDeploy = prisma(['migrate', 'deploy']);
if (secondDeploy.status !== 0) fail(secondDeploy);
forward(secondDeploy);
