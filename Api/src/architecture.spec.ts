/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Architecture / dependency-rule enforcement test (audit M2).
 * Dependency-free (Node fs only) — it scans the module sources and pins the couplings that ARE
 * allowed, so a NEW cross-context import or a Prisma-in-controller leak fails CI instead of eroding
 * the boundary silently. This encodes the layering the code actually follows (pragmatic
 * transaction-script over Prisma), NOT an aspirational per-module `domain/` rule.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODULES_DIR = join(__dirname, 'modules');

/** Shared security kernel: guards/decorators every context legitimately depends on. */
const SHARED_KERNEL = new Set(['auth']);

/** Explicitly-sanctioned cross-context couplings (`from->to`). Adding one here is a deliberate, */
/** reviewable act; anything not listed here is a boundary violation. */
const ALLOWED_CROSS_CONTEXT = new Set<string>([
  'customers->realtime',
  'customers->notification', // a KYC-status change fans a PII-free, preference-gated notification out
  'notification->realtime', // the notification domain publishes recipient-scoped notification.created over SSE
  'auth->notification', // auth emits recipient-scoped SECURITY_ALERTs (account-lockout + new-trusted-device + admin-MFA-reset) via ModuleRef lazy-resolve — cycle-safe, best-effort
  'password-reset->notification', // admin password-reset emits a recipient-scoped SECURITY_ALERT to the TARGET operator
  'auth->mfa', // the login decision tree + verify endpoints depend on the MFA primitives
  'password-reset->mfa', // the self-service reset reuses TotpService + BackupCodeService
]);

function listModules(): string[] {
  return readdirSync(MODULES_DIR).filter(name => statSync(join(MODULES_DIR, name)).isDirectory());
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.int-spec.ts')) {
      // .spec.ts and .int-spec.ts are TEST code (a test may legitimately import a collaborator module
      // to assert behaviour) — the dependency rule pins PRODUCTION sources only.
      out.push(full);
    }
  }
  return out;
}

describe('Api architecture (dependency rule — audit M2)', () => {
  const moduleNames = listModules();
  const files = sourceFiles(MODULES_DIR);

  it('finds module sources to check (guards against a silently-empty scan)', () => {
    expect(moduleNames.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it('controllers never import PrismaService (thin controllers delegate to services)', () => {
    const offenders = files
      .filter(f => f.endsWith('.controller.ts'))
      .filter(f => /\bPrismaService\b/.test(readFileSync(f, 'utf8')))
      .map(f => f.slice(f.indexOf('modules/')));
    expect(offenders).toEqual([]);
  });

  it('no cross-context module import beyond the shared kernel + sanctioned couplings', () => {
    const importRe = /from '\.\.\/([a-z0-9-]+)\//g;
    const violations: string[] = [];

    for (const file of files) {
      const ctxMatch = /modules\/([^/]+)\//.exec(file);
      const ctx = ctxMatch?.[1];
      if (!ctx) continue;
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const other = m[1];
        if (!moduleNames.includes(other) || other === ctx) continue;
        if (SHARED_KERNEL.has(other)) continue;
        if (ALLOWED_CROSS_CONTEXT.has(`${ctx}->${other}`)) continue;
        violations.push(`${ctx} -> ${other}  (${file.slice(file.indexOf('modules/'))})`);
      }
    }

    expect(violations).toEqual([]);
  });
});
