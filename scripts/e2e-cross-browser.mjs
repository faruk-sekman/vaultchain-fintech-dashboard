/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Cross-browser Cypress driver (zero-dependency, node:child_process only).
 *
 * Why not `npm run e2e:chrome && npm run e2e:electron`?
 *   - `&&` skips the electron leg when chrome fails, so one flaky browser hides the other's
 *     signal. Here BOTH legs always run and the process exits non-zero if EITHER failed.
 *   - `trashAssetsBeforeRuns: true` (cypress.config.ts) makes the second leg delete the first
 *     leg's artifacts in a local back-to-back run. The electron leg therefore appends
 *     `--config trashAssetsBeforeRuns=false` so the chrome artifacts survive.
 *
 * Invoked via `Web/package.json` → `e2e:cross-browser` (root: `web:e2e:cross-browser`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * @param {string} name
 * @param {string[]} extraArgs appended after `--` (passed through to `cypress run`)
 * @returns {{ name: string, exitCode: number }}
 */
function runLeg(name, extraArgs = []) {
  const args = ['--prefix', 'Web', 'run', `e2e:${name}`];
  if (extraArgs.length > 0) args.push('--', ...extraArgs);
  const result = spawnSync(npmCommand, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) console.error(`[e2e:cross-browser] ${name}: ${result.error.message}`);
  return { name, exitCode: result.status ?? 1 };
}

const legs = [
  runLeg('chrome'),
  // Keep the chrome leg's artifacts: only the first leg may trash cypress/artifacts.
  runLeg('electron', ['--config', 'trashAssetsBeforeRuns=false']),
];

let failed = false;
for (const leg of legs) {
  const ok = leg.exitCode === 0;
  if (!ok) failed = true;
  console.log(`[e2e:cross-browser] ${leg.name}: ${ok ? 'PASS' : `FAIL (exit ${leg.exitCode})`}`);
}
process.exit(failed ? 1 : 0);
