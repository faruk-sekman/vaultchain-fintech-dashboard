#!/usr/bin/env node
// Governance tooling (NOT product/app code): checks Angular ngx-translate
// locale parity, referenced keys, interpolation tokens, and visible literals.
// Default mode reports literal candidates as warnings; --strict-literals fails.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'Web');
const srcRoot = join(webRoot, 'src');
const i18nDir = join(srcRoot, 'assets', 'i18n');
const strictLiterals = process.argv.includes('--strict-literals');
const unknownArgs = process.argv.slice(2).filter(arg => arg !== '--strict-literals');

if (unknownArgs.length) {
  console.error(`i18n-check: unknown arg(s): ${unknownArgs.join(', ')}`);
  process.exit(64);
}

const trFile = join(i18nDir, 'tr.json');
const enFile = join(i18nDir, 'en.json');
const errors = [];
const warnings = [];

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

const flatten = (value, prefix = '', out = new Map()) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out.set(prefix, value);
  return out;
};

const difference = (left, right) => [...left].filter(item => !right.has(item)).sort();

const interpolationTokens = value => {
  const tokens = new Set();
  if (typeof value !== 'string') return tokens;
  const pattern = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
  let match;
  while ((match = pattern.exec(value)) !== null) tokens.add(match[1]);
  return tokens;
};

const walkFiles = (dir, files = []) => {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage', '.angular'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, files);
    else if (['.ts', '.html'].includes(extname(entry.name)) && !entry.name.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
};

/**
 * Backend error-catalog drift gate (A3, bugfix-backlog-2026-07). Extracts every domain error code
 * the Api can emit (quoted `Domain.Code` PascalCase literals in non-test source — the error-envelope
 * envelope convention) and fails when a code has no `errors.code.<Domain>.<Code>` translation in
 * BOTH locales, so a new backend code cannot ship without operator-facing copy. Orphan
 * translations (FE copy with no BE code) are surfaced as warnings, not failures.
 */
const collectApiErrorCodes = () => {
  const apiSrc = join(root, 'Api', 'src');
  const codes = new Set();
  const walkApi = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'coverage', 'generated'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkApi(full);
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('int-spec.ts')
      ) {
        const source = readFileSync(full, 'utf8');
        const pattern = /['"`]([A-Z][a-zA-Z]+\.[A-Z][A-Za-z_]+)['"`]/g;
        let match;
        while ((match = pattern.exec(source)) !== null) codes.add(match[1]);
      }
    }
  };
  walkApi(apiSrc);
  return codes;
};

const addKey = (keys, key, file, index, source) => {
  if (!key || key.includes('${') || key.includes('+')) return;
  keys.push({ key, file, line: source.slice(0, index).split('\n').length });
};

const findTranslationKeys = (source, file) => {
  const keys = [];
  const patterns = [
    /(['"`])([A-Za-z0-9_.-]+)\1\s*\|\s*translate/g,
    /\b(?:this\.)?(?:i18n|translate)\.(?:instant|get|stream)\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g,
    /\btranslate:\s*(['"`])([A-Za-z0-9_.-]+)\1/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) addKey(keys, match[2], file, match.index, source);
  }
  return keys;
};

const stripAngularNoise = source =>
  source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<i\b[^>]*>[\s\S]*?<\/i>/g, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/g, '');

const isHumanLiteral = value => {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < 2) return false;
  if (text.includes('{{') || text.includes('| translate')) return false;
  if (!/[A-Za-zÀ-ÖØ-öø-ÿİıĞğÜüŞşÖöÇç]/.test(text)) return false;
  if (/^[A-Z0-9_./:#-]+$/.test(text)) return false;
  if (/^(true|false|button|submit|reset|noopener|noreferrer|_blank)$/i.test(text)) return false;
  if (/^https?:\/\//i.test(text) || text.startsWith('/') || text.startsWith('#')) return false;
  return true;
};

const findLiteralCandidates = (source, file) => {
  if (!file.endsWith('.html')) return [];
  // Only Angular component templates (src/app/**) use ngx-translate; index.html and other
  // non-template HTML cannot use the translate pipe, so they are not literal-scanned.
  if (!file.replace(/\\/g, '/').includes('/src/app/')) return [];
  const clean = stripAngularNoise(source);
  const findings = [];
  const attrPattern = /\b(placeholder|title|alt|aria-label)=["']([^"']+)["']/g;
  const textPattern = />([^<>{}@]+)</g;

  for (const pattern of [attrPattern, textPattern]) {
    let match;
    while ((match = pattern.exec(clean)) !== null) {
      const value = pattern === attrPattern ? match[2] : match[1];
      if (isHumanLiteral(value)) {
        findings.push({
          file,
          line: clean.slice(0, match.index).split('\n').length,
          value: value.replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return findings;
};

if (!existsSync(trFile) || !existsSync(enFile)) {
  errors.push('Missing Web/src/assets/i18n/tr.json or en.json');
} else {
  const trValues = flatten(readJson(trFile));
  const enValues = flatten(readJson(enFile));
  const trKeys = new Set(trValues.keys());
  const enKeys = new Set(enValues.keys());

  for (const key of difference(trKeys, enKeys)) errors.push(`missing in en.json: ${key}`);
  for (const key of difference(enKeys, trKeys)) errors.push(`missing in tr.json: ${key}`);

  for (const key of [...trKeys].filter(key => enKeys.has(key)).sort()) {
    const missingInEn = difference(interpolationTokens(trValues.get(key)), interpolationTokens(enValues.get(key)));
    const missingInTr = difference(interpolationTokens(enValues.get(key)), interpolationTokens(trValues.get(key)));
    if (missingInEn.length || missingInTr.length) {
      errors.push(
        `${key}: interpolation token mismatch` +
          `${missingInEn.length ? `; missing in en: ${missingInEn.join(', ')}` : ''}` +
          `${missingInTr.length ? `; missing in tr: ${missingInTr.join(', ')}` : ''}`,
      );
    }
  }

  const referencedKeys = [];
  const literalCandidates = [];
  for (const file of walkFiles(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    referencedKeys.push(...findTranslationKeys(source, file));
    literalCandidates.push(...findLiteralCandidates(source, file));
  }

  for (const ref of referencedKeys) {
    if (!trKeys.has(ref.key) || !enKeys.has(ref.key)) {
      errors.push(`${relative(root, ref.file)}:${ref.line} references missing key "${ref.key}"`);
    }
  }

  for (const item of literalCandidates.slice(0, 40)) {
    warnings.push(`${relative(root, item.file)}:${item.line} visible literal candidate ${JSON.stringify(item.value)}`);
  }
  if (literalCandidates.length > 40) {
    warnings.push(`... ${literalCandidates.length - 40} more visible literal candidate(s)`);
  }

  // --- Backend error-catalog drift gate (A3) ---
  const apiCodes = collectApiErrorCodes();
  const catalogPrefix = 'errors.code.';
  const translatedCodes = new Set(
    [...trKeys].filter(k => k.startsWith(catalogPrefix) && enKeys.has(k)).map(k => k.slice(catalogPrefix.length)),
  );
  for (const code of [...apiCodes].sort()) {
    if (!translatedCodes.has(code)) {
      errors.push(`error-catalog: backend code "${code}" has no errors.code.${code} translation (TR+EN)`);
    }
  }
  for (const code of [...translatedCodes].sort()) {
    if (!apiCodes.has(code)) {
      warnings.push(`error-catalog: errors.code.${code} has no matching backend code (stale?)`);
    }
  }

  console.log(
    `i18n-check: ${trKeys.size} TR keys, ${enKeys.size} EN keys, ${referencedKeys.length} static references, ${literalCandidates.length} literal candidate(s), error catalog ${apiCodes.size} BE codes / ${translatedCodes.size} translated.`,
  );
}

if (warnings.length) {
  console.log('i18n-check warnings:');
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (errors.length || (strictLiterals && warnings.length)) {
  console.error('i18n-check failed:');
  for (const error of errors) console.error(`- ${error}`);
  if (strictLiterals) for (const warning of warnings) console.error(`- ${warning}`);
  process.exit(1);
}

console.log('i18n-check: OK');
