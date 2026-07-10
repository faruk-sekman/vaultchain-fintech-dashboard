#!/usr/bin/env node
// Governance/security tooling (NOT product/app code): fails when sensitive or
// generated files are TRACKED by git. It does not inspect file contents.
// Node port of the original shell script (zero dependencies; portable; matches
// the repo's .mjs governance convention). Run: npm run sensitive:check
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const patterns = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.[^/]+$/,
  /(^|\/)[^/]*\.pem$/,
  /(^|\/)[^/]*\.key$/,
  /(^|\/)[^/]*\.p12$/,
  /(^|\/)[^/]*\.pfx$/,
  /(^|\/)[^/]*_rsa$/,
  /(^|\/)secrets\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /(^|\/)\.angular\//,
  /(^|\/)\.nest\//,
  /(^|\/)\.DS_Store$/,
  /^\.codex\//,
  /^\.claude\/settings\.local\.json$/,
  /^\.claude\/launch\.json$/,
  /^\.mcp\.json$/,
];
const allowed = [/\.env\.example$/, /\.example\.env$/, /\.example$/, /^docs\/assets\/screenshots\//];

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('sensitive-check: unable to run `git ls-files` (is this a git repo?)');
  process.exit(1);
}

const findings = tracked.filter(f => patterns.some(p => p.test(f)) && !allowed.some(a => a.test(f)));

if (findings.length) {
  console.error('Sensitive or generated files are tracked by git:');
  for (const f of findings) console.error(`  ${f}`);
  console.error('\nKeep only safe examples/templates tracked. Remove generated or');
  console.error('secret-bearing files from the index after explicit approval.');
  process.exit(1);
}

console.log(`sensitive-check: OK (${tracked.length} tracked files scanned)`);
