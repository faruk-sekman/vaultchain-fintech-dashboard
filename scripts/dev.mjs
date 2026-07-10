#!/usr/bin/env node
// Root DEV orchestrator (dev tooling, NOT product/app code): one command to run the
// stack locally, without touching secrets and without wiping existing data.
//   npm run dev         # Postgres (compose "db") + API (watch) + Web (serve)
//   npm run dev:api     # Postgres + API only
//   npm run dev:web     # Web only (assumes an API is reachable at :3000)
//   npm run db:reset    # force a clean reseed (destroys dev data ON PURPOSE)
//
// Destructive schema sync is opt-in: the DEFAULT startup applies the committed migrations with
// `Api/scripts/db-deploy.mjs` (fresh-clone-safe — creates the schema unprompted, and baselines a
// database that predates the migrations directory instead of dropping it). A destructive
// `prisma migrate reset` runs ONLY on `npm run db:reset` (intentional reset) or when
// FTD_DB_ACCEPT_DATA_LOSS=1 is set explicitly.
// Integrity SQL is additive/idempotent and runs after the migrations so local/demo DBs carry the
// same partial indexes / constraints that Prisma schema cannot express.
//
// Seed-once contract: scripts/seed-dev.ts is a FULL-RESET seed (it deletes + rebuilds),
// so it is gated behind a sentinel check ("does the DB already have users?"). On a normal
// run an already-populated DB is left untouched — the seed only runs when the DB is empty.
//
// Reproducible & fresh-clone-safe: the database is the compose "db" service (defined in
// docker-compose.yml + published to the host by docker-compose.override.yml), NOT the
// original developer's ad-hoc `ftd-local-pg` container. Zero dependencies (Node stdlib).
// No package installs, no deploys, no git writes.
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const onlyArg = args.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'both';
const mode = args.includes('--db-reset') ? 'db-reset' : args.includes('--db-only') ? 'db-only' : 'run';

if (!['both', 'api', 'web'].includes(only)) {
  process.stderr.write(`dev: invalid --only "${only}" (expected api|web)\n`);
  process.exit(64);
}

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';

const DB_HOST_PORT = process.env.DB_HOST_PORT || '55432';
const DATABASE_URL =
  process.env.DATABASE_URL || `postgresql://postgres:postgres@localhost:${DB_HOST_PORT}/fintech_dev?schema=public`;
// Clearly-labeled DEV-ONLY placeholders. NODE_ENV=development keeps the API's production
// hardening gates (strong secrets / PII master key / secure Redis) off by design.
const apiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: process.env.PORT || '3000',
  DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'change-me-local-dev-only-min-16',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'change-me-local-dev-only-min-16',
};

const log = m => process.stdout.write(`\x1b[36m▶ ${m}\x1b[0m\n`);
const ok = m => process.stdout.write(`\x1b[32m✓ ${m}\x1b[0m\n`);
const fail = m => {
  process.stderr.write(`\x1b[31m✗ ${m}\x1b[0m\n`);
  process.exit(1);
};

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', ...opts });
const capture = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], ...opts }).toString();

function requireDocker() {
  try {
    execFileSync('docker', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('Docker was not found. Install Docker Desktop and make sure it is running.');
  }
}

async function ensureDb() {
  requireDocker();
  log('Starting Postgres (Compose "db" service)…');
  run('docker', ['compose', 'up', '-d', 'db']);
  process.stdout.write('  waiting for readiness');
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'postgres', '-d', 'fintech_dev'], {
        cwd: root,
        stdio: 'ignore',
      });
      process.stdout.write(' ✓\n');
      return;
    } catch {
      process.stdout.write('.');
      await sleep(1000);
    }
  }
  process.stdout.write('\n');
  fail('Postgres did not become healthy before the timeout.');
}

// Sentinel: is the DB FULLY seeded? We check public.metric_daily — the analytics rollup the
// seed backfills last — so a partial/old volume (base tables but no rollup) is treated as
// "not seeded" and gets a clean reseed. A missing table (fresh volume) throws -> "not seeded".
// Uses the db container's own psql (zero host deps).
function isSeeded() {
  try {
    const out = capture('docker', [
      'compose', 'exec', '-T', 'db',
      'psql', '-U', 'postgres', '-d', 'fintech_dev', '-tAc', 'SELECT count(*) FROM public.metric_daily',
    ]);
    return Number.parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

// Applying migrations is idempotent (already-applied migrations are skipped); the seed is what we gate.
// DEFAULT startup deploys them (fresh-clone-safe, and baselines a pre-migrations database rather than
// dropping it). A destructive `migrate reset` is opt-in: only on an intentional reset (force) or an
// explicit FTD_DB_ACCEPT_DATA_LOSS=1.
function applySchema({ force = false } = {}) {
  const apiDir = join(root, 'Api');
  if (force || process.env.FTD_DB_ACCEPT_DATA_LOSS === '1') {
    log('Resetting the schema (prisma migrate reset — existing data will be deleted)…');
    run(npx, ['prisma', 'migrate', 'reset', '--force'], { cwd: apiDir, env: apiEnv });
  } else {
    log('Applying the schema (prisma migrate deploy)…');
    run(process.execPath, ['scripts/db-deploy.mjs'], { cwd: apiDir, env: apiEnv });
  }
  log('Applying data-integrity SQL (prisma/sql/integrity.sql)…');
  run(npx, ['prisma', 'db', 'execute', '--file', 'prisma/sql/integrity.sql'], { cwd: join(root, 'Api'), env: apiEnv });
}
function seed() {
  log('Loading seed data (seed-dev.ts) — 3 users + 1,500 customers + wallets/transactions + analytics…');
  run(npx, ['ts-node', 'scripts/seed-dev.ts'], { cwd: join(root, 'Api'), env: apiEnv });
}

function initDb({ force = false } = {}) {
  applySchema({ force });
  if (!force && isSeeded()) {
    ok('The database is already populated — seeding skipped (existing data was not changed).');
    return;
  }
  seed();
  ok(force ? 'The database was reset with a clean seed.' : 'The database was initialized and seeded.');
}

function printUrls({ web = false, api = false } = {}) {
  process.stdout.write('\n\x1b[1mApplication:\x1b[0m\n');
  if (web) process.stdout.write('  Web  → \x1b[4mhttp://localhost:4200\x1b[0m\n');
  if (api) process.stdout.write('  API  → \x1b[4mhttp://localhost:3000/api/v1/health\x1b[0m\n');
  process.stdout.write(
    '  Login → admin@example.com · operator@example.com · auditor@example.com  (password: Test-Passw0rd!)\n\n',
  );
}

function startProc(name, cmd, cmdArgs, env) {
  const child = spawn(cmd, cmdArgs, { cwd: root, env });
  const color = name === 'api' ? '\x1b[35m' : '\x1b[33m';
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (src, dst) => {
    let buf = '';
    src.setEncoding('utf8');
    src.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) dst.write(tag + l + '\n');
    });
    src.on('end', () => {
      if (buf) dst.write(tag + buf + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('error', err => fail(`Could not start "${name}": ${err.message}`));
  return child;
}

function wire(children) {
  let shuttingDown = false;
  let alive = children.length;
  let exitCode = 0;
  const finish = () => process.exit(exitCode);
  const killAll = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) {
      try {
        c.kill(signal);
      } catch {
        /* already gone */
      }
    }
    // Safety net: if a child ignores the signal, never hang the user's terminal.
    setTimeout(finish, 4000).unref();
  };
  process.on('SIGINT', () => {
    process.stdout.write('\n');
    log('Shutting down…');
    killAll('SIGINT');
  });
  process.on('SIGTERM', () => killAll('SIGTERM'));
  for (const c of children) {
    c.on('exit', code => {
      alive -= 1;
      if (!shuttingDown) {
        exitCode = code ?? 1;
        log(`A process exited (code ${code ?? 'null'}); shutting down the remaining processes…`);
        killAll('SIGTERM');
      }
      if (alive <= 0) finish(); // all children down -> release the terminal
    });
  }
}

async function main() {
  // Web-only never needs the database.
  if (only === 'web' && mode === 'run') {
    log('Starting Web only (ng serve)…');
    printUrls({ web: true });
    wire([startProc('web', npm, ['--prefix', 'Web', 'run', 'start'], process.env)]);
    return;
  }

  await ensureDb();

  if (mode === 'db-reset') {
    initDb({ force: true });
    return;
  }
  initDb();
  if (mode === 'db-only') {
    ok('Ready. Start the application with: npm run dev');
    return;
  }

  const children = [startProc('api', npm, ['--prefix', 'Api', 'run', 'start:dev'], apiEnv)];
  if (only !== 'api') children.push(startProc('web', npm, ['--prefix', 'Web', 'run', 'start'], process.env));
  printUrls({ web: only !== 'api', api: true });
  wire(children);
}

main().catch(e => fail(e?.message || String(e)));
