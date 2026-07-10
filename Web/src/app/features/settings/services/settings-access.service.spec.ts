/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, expect, it } from 'vitest';

import { SettingsAccessService } from './settings-access.service';

describe('SettingsAccessService', () => {
  const service = new SettingsAccessService();

  it('groups permissions by resource and sorts groups and codes', () => {
    expect(
      service.groupPermissions(['customers.read', 'auth.mfa.admin_reset', 'customers.delete', '']),
    ).toEqual([
      { resource: 'auth', items: ['auth.mfa.admin_reset'] },
      { resource: 'customers', items: ['customers.delete', 'customers.read'] },
      { resource: 'other', items: [''] },
    ]);
  });

  it('maps grouped permissions to category-tagged access rows with sensitive flags', () => {
    const rows = service.toAccessRows(
      service.groupPermissions(['customers.pii.reveal', 'wallets.manage-limits', 'kyc.read']),
    );

    expect(rows.map(row => row.resource)).toEqual(['customers', 'kyc', 'wallets']);
    expect(rows.find(row => row.resource === 'customers')?.category).toBe('customer');
    expect(rows.find(row => row.resource === 'kyc')?.category).toBe('kyc');
    expect(rows.find(row => row.resource === 'wallets')?.category).toBe('financial');
    expect(rows.find(row => row.resource === 'customers')?.scopes[0]).toEqual({
      code: 'customers.pii.reveal',
      action: 'pii.reveal',
      sensitive: true,
    });
  });

  it('falls back unknown resources to the identity category', () => {
    const rows = service.toAccessRows(service.groupPermissions(['newdomain.audit']));

    expect(rows).toHaveLength(1);
    expect(rows[0].resource).toBe('newdomain');
    expect(rows[0].category).toBe('identity');
    expect(rows[0].scopes[0]).toEqual({
      code: 'newdomain.audit',
      action: 'audit',
      sensitive: false,
    });
  });

  it('counts only classified-sensitive permissions', () => {
    expect(
      service.sensitiveCount([
        'customers.read',
        'customers.delete',
        'auth.password.admin_reset',
        'roles.read',
      ]),
    ).toBe(2);
  });

  it('strips the resource prefix from permission actions', () => {
    expect(service.permissionAction('wallets.manage-limits')).toBe('manage-limits');
    expect(service.permissionAction('flat')).toBe('flat');
  });
});
