/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Seed/RBAC unit test. Asserts the dev seed's permission dictionary + role matrix are coherent:
 *  - the orphaned `audit-logs.read` capability (no controller serves it) is not seeded.
 *  - the limit route is gated by the canonical `wallets.manage-limits`, so the previously
 *    orphaned bare `wallets.manage` is not seeded.
 *  - the dictionary gains `customers.pii.reveal` (response-scope) + `customers.delete`
 *    (Admin-only `@Delete` gate); three roles (administrator / operator "Compliance Officer" / auditor "Viewer")
 *    carry the exact matrix; `PERMISSIONS` equals the union of role codes (no silent drift); and the PER-ROLE
 *    prune selection downscopes a legacy broad role to its matrix without self-revoking its own codes.
 * Imports the constants from the seed script; the script's `require.main === module` guard means this import
 * triggers NO database connection — these tests are DB-free (the prune SELECTION predicate is modeled, not run).
 */
import { ALL_ROLE_CODES, PERMISSIONS, ROLES } from '../../../scripts/seed-dev';

const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

// Mirrors the real PER-ROLE prune filter `permission: { code: { notIn: <THAT role's codes> } }`: a stored
// grant is selected for deletion on a role exactly when its code is absent from that role's matrix.
const wouldBePruned = (code: string, roleCodes: readonly string[]): boolean => !roleCodes.includes(code);

const adminCodes = ROLES.find((r) => r.name === 'administrator')!.codes;
const operatorCodes = ROLES.find((r) => r.name === 'operator')!.codes;
const auditorCodes = ROLES.find((r) => r.name === 'auditor')!.codes;

describe('seed-dev PERMISSIONS dictionary', () => {
  it('no longer seeds the orphaned audit-logs.read capability', () => {
    expect(PERMISSIONS).not.toContain('audit-logs.read');
  });

  it('seeds no audit-logs.* capability at all (no sibling orphan slips back in)', () => {
    expect(PERMISSIONS.filter((code) => code.startsWith('audit-logs'))).toEqual([]);
  });

  it('no longer seeds the now-orphaned bare wallets.manage capability', () => {
    expect(PERMISSIONS).not.toContain('wallets.manage');
  });

  it('grants exactly one wallets.manage* write capability (no bare-manage orphan slips back in)', () => {
    // Neither new code (`customers.*`) starts with `wallets.manage`, so this remains exactly the one.
    expect(PERMISSIONS.filter((code) => code.startsWith('wallets.manage'))).toEqual(['wallets.manage-limits']);
  });

  it('still grants the permissions real controllers enforce (now 17 incl. the A12 customers.update gate)', () => {
    const required = [
      'customers.read',
      'customers.manage',
      'customers.update',
      'customers.delete',
      'customers.pii.reveal',
      'wallets.read',
      'wallets.manage-limits',
      'transactions.read',
      'transactions.create',
      'kyc.read',
      'kyc.manage',
      'roles.read',
      'roles.manage',
      'permissions.manage',
      'users.manage',
      'auth.mfa.admin_reset',
      'auth.password.admin_reset',
    ];
    for (const code of required) expect(PERMISSIONS).toContain(code);
    expect(PERMISSIONS).toHaveLength(17);
  });

  it('has no duplicate permission codes (seed/grant integrity)', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});

describe('seed-dev ROLES ⟷ PERMISSIONS', () => {
  it('PERMISSIONS equals the union of every role\'s codes as a set (no dictionary/grants drift)', () => {
    // The drift guard: if a future edit adds a code to a role but not PERMISSIONS (or vice versa), this fails.
    expect(uniqSorted(PERMISSIONS)).toEqual(uniqSorted(ROLES.flatMap((r) => r.codes)));
    expect(uniqSorted(PERMISSIONS)).toEqual(uniqSorted(ALL_ROLE_CODES));
  });

  it('documents customers.pii.reveal as a RESPONSE-SCOPE permission held ONLY by Administrator', () => {
    // customers.pii.reveal is NOT a standalone @RequirePermissions route gate — it is
    // resolved inside CustomersService from principal.permissions to unmask PII on the customers.read-gated GET
    // routes. Pinned here so a future edit that tries to gate a route solely on it gets reviewed. Least privilege:
    expect(PERMISSIONS).toContain('customers.pii.reveal');
    expect(adminCodes).toContain('customers.pii.reveal');
    expect(operatorCodes).not.toContain('customers.pii.reveal');
    expect(auditorCodes).not.toContain('customers.pii.reveal');
  });

  it('documents auth.password.admin_reset as the admin-only password-reset fallback gate', () => {
    expect(PERMISSIONS).toContain('auth.password.admin_reset');
    expect(adminCodes).toContain('auth.password.admin_reset');
    expect(operatorCodes).not.toContain('auth.password.admin_reset');
    expect(auditorCodes).not.toContain('auth.password.admin_reset');
  });

  it('documents customers.delete as the @Delete(:id)-served, Administrator-only gate', () => {
    expect(PERMISSIONS).toContain('customers.delete');
    expect(adminCodes).toContain('customers.delete');
    expect(operatorCodes).not.toContain('customers.delete');
    expect(auditorCodes).not.toContain('customers.delete');
  });

  it('Administrator holds the full dictionary', () => {
    expect(uniqSorted(adminCodes)).toEqual(uniqSorted(PERMISSIONS));
  });

  it('Operator (Compliance Officer) is day-to-day ops MINUS delete, reveal, and role/permission/user mgmt', () => {
    expect(operatorCodes).toEqual(
      expect.arrayContaining([
        'customers.read',
        'customers.manage',
        'wallets.read',
        'wallets.manage-limits',
        'transactions.read',
        'transactions.create',
        'kyc.read',
        'kyc.manage',
        'roles.read',
      ]),
    );
    for (const denied of ['customers.delete', 'customers.pii.reveal', 'roles.manage', 'permissions.manage', 'users.manage']) {
      expect(operatorCodes).not.toContain(denied);
    }
  });

  it('Auditor (Viewer) is strictly read-only (no *.manage / *.create / *.delete / *.reveal)', () => {
    expect(uniqSorted(auditorCodes)).toEqual(
      uniqSorted(['customers.read', 'wallets.read', 'transactions.read', 'kyc.read', 'roles.read']),
    );
    for (const code of auditorCodes) {
      expect(code).toMatch(/\.read$/);
    }
  });
});

describe('seed-dev PER-ROLE prune selection (re-seed convergence + downscope)', () => {
  it('selects the historical orphan codes for deletion on EVERY role (absent from every matrix)', () => {
    for (const role of ROLES) {
      expect(wouldBePruned('audit-logs.read', role.codes)).toBe(true);
      expect(wouldBePruned('wallets.manage', role.codes)).toBe(true);
    }
  });

  it('downscopes a legacy broad Operator: management codes ARE pruned on the Operator role (D4)', () => {
    expect(wouldBePruned('users.manage', operatorCodes)).toBe(true);
    expect(wouldBePruned('roles.manage', operatorCodes)).toBe(true);
    expect(wouldBePruned('permissions.manage', operatorCodes)).toBe(true);
    expect(wouldBePruned('customers.delete', operatorCodes)).toBe(true);
    expect(wouldBePruned('customers.pii.reveal', operatorCodes)).toBe(true);
    // …but its own matrix codes are NOT pruned.
    expect(wouldBePruned('customers.read', operatorCodes)).toBe(false);
    expect(wouldBePruned('kyc.manage', operatorCodes)).toBe(false);
  });

  it('never selects a role\'s OWN matrix code for deletion on that role (no self-revocation)', () => {
    for (const role of ROLES) {
      for (const code of role.codes) {
        expect(wouldBePruned(code, role.codes)).toBe(false);
      }
    }
  });
});
