#!/usr/bin/env node
// Governance/security tooling (NOT product/app code): checks package manifests
// and npm lockfiles against the dependency/license policy.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strictTransitive = process.argv.includes('--strict-transitive');
const unknownArgs = process.argv.slice(2).filter(arg => arg !== '--strict-transitive');

if (unknownArgs.length) {
  console.error(`dependency-policy: unknown arg(s): ${unknownArgs.join(', ')}`);
  process.exit(64);
}

const allowedLicenseTokens = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'PostgreSQL',
  'Unlicense',
]);
const approvalRequired = [
  'AGPL',
  'BSL',
  'CC-BY-NC',
  'GPL',
  'LGPL',
  'SSPL',
  'Commercial',
  'SEE LICENSE',
  'UNLICENSED',
];
const blockedPackages = new Set(['plain-crypto-js', 'mediatR', 'automapper']);
// Transitive deps whose npm metadata omits a license field but were manually verified (audit trail).
// MIT — verified upstream (LICENSE file / README present); the npm lockfile omits the license field.
const reviewedMissingLicense = new Set([
  'svg-tags', // MIT — verified upstream
  'exit', // MIT — Api/: LICENSE-MIT present (Ben Alman)
  'passport-strategy', // MIT — Api/: LICENSE present (Jared Hanson)
  'pause', // MIT — Api/: stated in Readme.md
  'seq-queue', // MIT — Api/: LICENSE present (Netease/pomelo)
]);
const packageRoots = ['.', 'Web', 'Api'];
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const errors = [];
const warnings = [];

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const rel = file => relative(root, file) || '.';

const packageJsonPath = dir => join(root, dir, 'package.json');
const packageLockPath = dir => join(root, dir, 'package-lock.json');

const hasDependencies = manifest =>
  dependencyFields.some(field => Object.keys(manifest[field] ?? {}).length > 0);

const licenseTokens = license =>
  String(license ?? '')
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/i)
    .map(token => token.trim())
    .filter(Boolean);

const licenseIsAllowed = license => {
  const tokens = licenseTokens(license);
  if (!tokens.length) return false;
  return tokens.every(token => allowedLicenseTokens.has(token));
};

const licenseNeedsApproval = license => {
  const raw = String(license ?? '').trim();
  if (!raw) return true;
  return approvalRequired.some(pattern => raw.toLowerCase().includes(pattern.toLowerCase()));
};

const inspectSpec = (file, packageName, spec, context) => {
  const normalized = String(spec ?? '').trim();
  if (!normalized) {
    errors.push(`${rel(file)} ${context}: ${packageName} has an empty version spec`);
  }
  if (normalized === '*' || normalized.toLowerCase() === 'latest') {
    errors.push(`${rel(file)} ${context}: ${packageName} uses forbidden floating spec "${normalized}"`);
  }
  if (/^(file:|link:)/.test(normalized)) {
    warnings.push(`${rel(file)} ${context}: ${packageName} uses local spec "${normalized}"`);
  }
  if (blockedPackages.has(packageName) || [...blockedPackages].some(name => packageName.toLowerCase().includes(name.toLowerCase()))) {
    errors.push(`${rel(file)} ${context}: blocked package ${packageName}`);
  }
};

const inspectManifest = (dir, manifestFile) => {
  const manifest = readJson(manifestFile);
  for (const field of dependencyFields) {
    for (const [packageName, spec] of Object.entries(manifest[field] ?? {})) {
      inspectSpec(manifestFile, packageName, spec, `package.json ${field}`);
    }
  }

  if (hasDependencies(manifest) && !existsSync(packageLockPath(dir))) {
    errors.push(`${rel(manifestFile)} has dependencies but no package-lock.json for reproducible npm ci`);
  }

  return manifest;
};

const inspectLockfile = (lockFile, directDependencyNames) => {
  const lock = readJson(lockFile);
  let packageCount = 0;
  let directChecked = 0;
  let transitiveReview = 0;

  for (const [packagePath, info] of Object.entries(lock.packages ?? {})) {
    if (!packagePath) continue;
    packageCount += 1;
    const name = info.name ?? packagePath.replace(/^node_modules\//, '');
    const direct = directDependencyNames.has(name) || directDependencyNames.has(packagePath.replace(/^node_modules\//, ''));
    const license = info.license;

    if (blockedPackages.has(name) || [...blockedPackages].some(item => name.toLowerCase().includes(item.toLowerCase()))) {
      errors.push(`${rel(lockFile)} lockfile: blocked package ${name}`);
    }

    if (direct) {
      directChecked += 1;
      if (!licenseIsAllowed(license)) {
        errors.push(`${rel(lockFile)} lockfile direct dependency ${name}: license "${license ?? 'missing'}" is not auto-allowed by the dependency policy`);
      }
      continue;
    }

    if (!licenseIsAllowed(license)) {
      if (reviewedMissingLicense.has(name)) continue; // manually reviewed exception (see set above)
      transitiveReview += 1;
      const message = `${rel(lockFile)} lockfile transitive dependency ${name}: license "${license ?? 'missing'}" needs review`;
      if (strictTransitive || licenseNeedsApproval(license)) warnings.push(message);
    }
  }

  console.log(
    `dependency-policy: ${rel(lockFile)} scanned ${packageCount} packages (${directChecked} direct, ${transitiveReview} transitive review candidate(s)).`,
  );
};

let manifests = 0;
for (const dir of packageRoots) {
  const manifestFile = packageJsonPath(dir);
  if (!existsSync(manifestFile)) continue;
  manifests += 1;
  const manifest = inspectManifest(dir, manifestFile);
  const directDependencyNames = new Set(
    dependencyFields.flatMap(field => Object.keys(manifest[field] ?? {})),
  );
  const lockFile = packageLockPath(dir);
  if (existsSync(lockFile)) inspectLockfile(lockFile, directDependencyNames);
}

if (!manifests) {
  errors.push('No package.json files found at root/Web/Api');
}

if (warnings.length) {
  console.log('dependency-policy warnings:');
  for (const warning of warnings.slice(0, 40)) console.log(`- ${warning}`);
  if (warnings.length > 40) console.log(`- ... ${warnings.length - 40} more warning(s)`);
}

if (errors.length) {
  console.error('dependency-policy failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`dependency-policy: OK (${manifests} manifest(s))`);
