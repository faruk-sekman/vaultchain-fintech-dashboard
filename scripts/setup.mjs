#!/usr/bin/env node
// One-time LOCAL setup (dev tooling, NOT product/app code): install dependencies for
// both workspaces, then create + seed the dev database (only if empty). Idempotent —
// safe to re-run. After this, use `npm run dev`.
//   npm run setup
//
// This is the single "clone -> working demo" entry point. The `npm install` calls here
// are the user-invoked setup step (run intentionally), not an automatic background action.
// Zero dependencies (Node stdlib). No deploys, no git writes.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const node = process.execPath;

const log = m => process.stdout.write(`\x1b[36m▶ ${m}\x1b[0m\n`);
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit', ...opts });

log('1/3 · Installing API dependencies (npm install)…');
run(npm, ['--prefix', 'Api', 'install']);

log('2/3 · Installing Web dependencies (npm install)…');
run(npm, ['--prefix', 'Web', 'install']);

log('3/3 · Preparing the database (schema + seed only when empty)…');
run(node, ['scripts/dev.mjs', '--db-only']);

process.stdout.write('\n\x1b[32m✓ Setup complete.\x1b[0m Start with: \x1b[1mnpm run dev\x1b[0m\n');
process.stdout.write('  • both services: npm run dev   • API only: npm run dev:api   • Web only: npm run dev:web\n');
process.stdout.write('  • full Docker stack: docker compose up --build\n');
