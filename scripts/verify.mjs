#!/usr/bin/env node
// Root quality gate: the repo's static checks plus the Web and Api test/build
// pipelines — the same gates CI enforces, runnable offline before a commit/PR.
// No installs, no deploys, no git writes. Zero dependencies (Node stdlib only).
//   npm run verify        # static checks + Web lint/test/build + Api test/build
//   npm run verify:fast   # static checks + Web lint (skip test/build)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fast = args.includes('--fast') || args.includes('--skip-heavy');
const unknown = args.filter(a => !['--fast', '--skip-heavy'].includes(a));
if (unknown.length) {
  console.error(`verify: unknown arg(s): ${unknown.join(', ')}`);
  process.exit(64);
}

const node = process.execPath;
const TOTAL_GATES = 4;
const run = (label, cmd, cmdArgs) => {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  } catch (err) {
    console.error(`\n✗ verify failed at: ${label}`);
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
};
const gate = (n, label, cmd, cmdArgs) => run(`${n}/${TOTAL_GATES} ${label}`, cmd, cmdArgs);

const hasScript = (workspace, name) => {
  const pkg = join(root, workspace, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf8'));
    return Boolean(parsed.scripts && parsed.scripts[name]);
  } catch {
    return false;
  }
};

// --- static checks ---
gate(1, 'docs consistency', node, ['scripts/check-docs.mjs']);
gate(2, 'sensitive/generated tracking', node, ['scripts/check-sensitive-tracking.mjs']);
gate(3, 'i18n contract', node, ['scripts/i18n-check.mjs']);
gate(4, 'dependency/license policy', node, ['scripts/check-dependency-policy.mjs']);

// --- Web validation ---
if (hasScript('Web', 'lint:styles')) run('Web lint:styles', 'npm', ['--prefix', 'Web', 'run', 'lint:styles']);
else console.log('skip: Web has no lint:styles script');

if (fast) {
  console.log('skip: Web/Api test/build (--fast)');
} else {
  if (hasScript('Web', 'test')) run('Web test', 'npm', ['--prefix', 'Web', 'run', 'test']);
  else console.log('skip: Web has no test script');
  if (hasScript('Web', 'build')) run('Web build', 'npm', ['--prefix', 'Web', 'run', 'build']);
  else console.log('skip: Web has no build script');

  // --- Api validation ---
  if (hasScript('Api', 'test')) run('Api test', 'npm', ['--prefix', 'Api', 'run', 'test']);
  else console.log('skip: Api has no test script');
  if (hasScript('Api', 'build')) run('Api build', 'npm', ['--prefix', 'Api', 'run', 'build']);
  else console.log('skip: Api has no build script');
}

console.log('\n✓ verify: all requested gates passed');
