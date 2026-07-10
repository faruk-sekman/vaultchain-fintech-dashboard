#!/usr/bin/env node
// Documentation integrity gate (zero dependencies — Node stdlib only).
// Validates the DELIVERED docs — what git tracks — so a fresh clone is self-consistent:
//   1. Every relative markdown link `](...)` and image ref (markdown `![](...)` and
//      HTML `src="..."`) in every tracked .md file resolves to a tracked file or an
//      in-repo directory. Anchors (`#...`) are ignored; external targets
//      (http(s):, mailto:, tel:, data:) are skipped.
// On failure it prints a precise file:line report and exits non-zero.
//   npm run docs:check
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

// --- tracked-tree inventory (git is the source of truth: on-disk-but-untracked files don't count) ---
const gitLsFiles = patterns =>
  execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

const existingGitFiles = patterns => gitLsFiles(patterns).filter(f => existsSync(join(root, f)));

const trackedFiles = new Set(existingGitFiles([]));
const trackedDirs = new Set(['']); // '' = repo root
for (const f of trackedFiles) {
  let dir = posix.dirname(f);
  while (dir !== '.' && !trackedDirs.has(dir)) {
    trackedDirs.add(dir);
    dir = posix.dirname(dir);
  }
}
const mdFiles = existingGitFiles(['*.md']).sort();

// --- link + image-ref integrity ---
const EXTERNAL = /^(https?:|mailto:|tel:|data:|#)/i;
const LINK_RE = /\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g; // ](target) incl. one nesting level
const SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi; // HTML <img src="..."> in markdown

// Blank out fenced code blocks and inline code spans so example links don't count.
const stripCode = lines => {
  let fence = null;
  return lines.map(line => {
    const marker = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line.replace(/`[^`]*`/g, '`code`');
  });
};

const cleanTarget = raw => {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1); // ](<path with spaces>)
  t = t.replace(/\s+("[^"]*"|'[^']*')\s*$/, ''); // ](path "title")
  t = t.split('#')[0].split('?')[0]; // validate the file part only
  return t.trim();
};

// Repo-relative posix path for a target found in mdFile. Leading '/' = repo root.
const resolveRepoRel = (mdFile, target) => {
  const joined = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(posix.dirname(mdFile), target));
  return joined === '.' ? '' : joined;
};

let linksChecked = 0;
const checkTarget = (mdFile, lineNo, raw, kind) => {
  const target = cleanTarget(raw);
  if (!target || EXTERNAL.test(target)) return;
  linksChecked += 1;
  const repoRel = resolveRepoRel(mdFile, target);
  if (repoRel === '..' || repoRel.startsWith('../')) {
    errors.push(`${mdFile}:${lineNo}: ${kind} escapes the repository -> ${raw.trim()}`);
    return;
  }
  if (trackedFiles.has(repoRel) || trackedDirs.has(repoRel.replace(/\/+$/, ''))) return;
  errors.push(`${mdFile}:${lineNo}: broken ${kind} -> ${raw.trim()} (not a tracked file or in-repo path)`);
};

for (const mdFile of mdFiles) {
  const lines = stripCode(readFileSync(join(root, mdFile), 'utf8').split('\n'));
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LINK_RE)) checkTarget(mdFile, i + 1, m[1], 'link');
    for (const m of line.matchAll(SRC_RE)) checkTarget(mdFile, i + 1, m[1] ?? m[2], 'image ref');
  });
}

// --- report ---
console.log(`docs-check: ${mdFiles.length} tracked markdown files, ${linksChecked} relative links checked.`);
if (errors.length) {
  console.error('docs-check failed:');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log('docs-check: OK');
