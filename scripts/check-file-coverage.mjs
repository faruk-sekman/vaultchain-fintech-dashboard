#!/usr/bin/env node
/*
 * Per-FILE coverage gate (NOT product/app code) — the authoritative "file-level ≥90%" check.
 *
 * Why this exists: Jest's `coverageThreshold` glob keys are GROUP-aggregate (a glob's matched files
 * are checked as one combined number), NOT per-file — so a single regressed file can hide behind its
 * siblings. Vitest has `thresholds.perFile`, but using two different enforcement models across the two
 * stacks is harder to audit. This script gives ONE uniform, true per-file gate for BOTH `Api/` (Jest)
 * and `Web/` (Vitest): it reads each stack's `coverage-summary.json` and fails if ANY measured file
 * falls below the floor. The set of measured files is whatever each tool's `collectCoverageFrom` /
 * `coverage.exclude` already left in — i.e. genuine declaration-only files (decorator-only DTOs, param
 * decorators, type/interface modules, pure constants, the Prisma lifecycle service, FE `environments/*`)
 * are excluded UPSTREAM and never reach this gate. See the coverage policy notes for the rationale of
 * each exclusion and of the per-metric floors below.
 *
 * Zero dependencies; no installs, no writes, no git. Run AFTER coverage has been produced:
 *   (cd Api && npm run test:cov)   # writes Api/coverage/coverage-summary.json
 *   (cd Web && npm test)           # writes Web/coverage/coverage-summary.json
 *   node scripts/check-file-coverage.mjs
 *
 * Flags: --stack=api|web (check only one), --threshold=N (override the lines/branches/statements floor).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const stackArg = (args.find(a => a.startsWith('--stack=')) || '').split('=')[1] || 'all';
const thrArg = Number((args.find(a => a.startsWith('--threshold=')) || '').split('=')[1]);

// Per-metric floors. lines/branches/statements are the load-bearing "≥90" guarantee. `functions` is
// istanbul's noisiest metric (it counts every arrow, getter and defensive `.catch(() => …)` handler),
// so it carries the same 90 floor but is the one most likely to need a justified `/* v8 ignore */` on a
// provably-unreachable arm rather than a fabricated test. Tune here (single source of truth).
const FLOORS = {
  lines: Number.isFinite(thrArg) ? thrArg : 90,
  statements: Number.isFinite(thrArg) ? thrArg : 90,
  branches: Number.isFinite(thrArg) ? thrArg : 90,
  functions: 90,
};

const STACKS = [
  { key: 'api', label: 'Api (Jest unit)', summary: join(root, 'Api', 'coverage', 'coverage-summary.json') },
  { key: 'web', label: 'Web (Vitest)', summary: join(root, 'Web', 'coverage', 'coverage-summary.json') },
];

let hadError = false;
let checkedAnyStack = false;

for (const stack of STACKS) {
  if (stackArg !== 'all' && stackArg !== stack.key) continue;
  if (!existsSync(stack.summary)) {
    console.error(`✗ ${stack.label}: coverage-summary.json not found at ${relative(root, stack.summary)}`);
    console.error(`  Run the stack's coverage first (Api: npm run test:cov · Web: npm test), then re-run.`);
    hadError = true;
    continue;
  }
  checkedAnyStack = true;
  const summary = JSON.parse(readFileSync(stack.summary, 'utf8'));
  const failures = [];
  let files = 0;
  for (const [file, m] of Object.entries(summary)) {
    if (file === 'total') continue;
    files += 1;
    const below = Object.entries(FLOORS).filter(([metric, floor]) => m[metric].pct < floor);
    if (below.length) {
      failures.push({
        file,
        detail: below.map(([metric]) => `${metric} ${m[metric].pct}% < ${FLOORS[metric]}%`).join(', '),
      });
    }
  }
  if (failures.length) {
    hadError = true;
    console.error(`\n✗ ${stack.label}: ${failures.length}/${files} file(s) below the per-file floor:`);
    for (const f of failures) {
      console.error(`   ${relative(root, f.file)}\n      ${f.detail}`);
    }
  } else {
    console.log(`✓ ${stack.label}: all ${files} measured files ≥ floor (lines/branches/statements/functions ≥ ${FLOORS.lines}/${FLOORS.branches}/${FLOORS.statements}/${FLOORS.functions}%)`);
  }
}

if (!checkedAnyStack && !hadError) {
  console.error('✗ check-file-coverage: no coverage summaries found for the requested stack(s).');
  hadError = true;
}

process.exit(hadError ? 1 : 0);
