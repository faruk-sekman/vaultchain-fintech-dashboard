/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';

import type {
  AccessCategory,
  AccessCategoryItem,
  AccessPermissionGroup,
  AccessResourceRow,
} from '../models/settings.models';

const ACCESS_CATEGORY_BY_RESOURCE: Readonly<Record<string, AccessCategory>> = {
  auth: 'identity',
  permissions: 'identity',
  roles: 'identity',
  users: 'identity',
  customers: 'customer',
  kyc: 'kyc',
  transactions: 'financial',
  wallets: 'financial',
};

const ACCESS_CATEGORIES: ReadonlyArray<AccessCategoryItem> = [
  { key: 'identity', labelKey: 'settings.access.categoryIdentity' },
  { key: 'customer', labelKey: 'settings.access.categoryCustomer' },
  { key: 'kyc', labelKey: 'settings.access.categoryKyc' },
  { key: 'financial', labelKey: 'settings.access.categoryFinancial' },
];

const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  'auth.mfa.admin_reset',
  'auth.password.admin_reset',
  'customers.delete',
  'customers.pii.reveal',
  'wallets.manage-limits',
]);

@Injectable({ providedIn: 'root' })
export class SettingsAccessService {
  readonly categories = ACCESS_CATEGORIES;

  groupPermissions(permissions: readonly string[]): ReadonlyArray<AccessPermissionGroup> {
    const groups = new Map<string, string[]>();
    for (const permission of permissions) {
      const resource = permission.split('.')[0] || 'other';
      const bucket = groups.get(resource);
      if (bucket) bucket.push(permission);
      else groups.set(resource, [permission]);
    }
    return [...groups.entries()]
      .map(([resource, items]) => ({
        resource,
        items: [...items].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }

  toAccessRows(groups: readonly AccessPermissionGroup[]): AccessResourceRow[] {
    return groups.map(group => ({
      resource: group.resource,
      category: ACCESS_CATEGORY_BY_RESOURCE[group.resource] ?? 'identity',
      scopes: group.items.map(code => ({
        code,
        action: this.permissionAction(code),
        sensitive: SENSITIVE_PERMISSIONS.has(code),
      })),
    }));
  }

  sensitiveCount(permissions: readonly string[]): number {
    return permissions.filter(code => SENSITIVE_PERMISSIONS.has(code)).length;
  }

  permissionAction(code: string): string {
    const dot = code.indexOf('.');
    return dot === -1 ? code : code.slice(dot + 1);
  }
}
