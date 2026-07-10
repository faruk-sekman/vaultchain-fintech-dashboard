/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * TR/EN parity GUARD for the `mfa.*` i18n key-set. The MFA surface (login
 * verify, setup wizard, settings card, trusted devices, admin reset) is fully localized; this spec
 * asserts the two bundles expose the IDENTICAL `mfa.*` key paths so a key added to one language can
 * never silently ship missing in the other (which would render a raw key to the operator). It adds
 * NO new i18n keys — it only freezes the existing parity. Mirrors the per-feature parity pattern in
 * `customers.api.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import enBundle from '../../../assets/i18n/en.json';
import trBundle from '../../../assets/i18n/tr.json';

/** Flatten a nested translation object to sorted dotted leaf paths (string leaves only). */
function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      out.push(...flattenKeys(value, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

describe('mfa.* i18n parity', () => {
  const en = (enBundle as Record<string, unknown>)['mfa'];
  const tr = (trBundle as Record<string, unknown>)['mfa'];

  it('defines an mfa.* block in BOTH the en and tr bundles', () => {
    expect(en, 'en.json is missing the mfa block').toBeDefined();
    expect(tr, 'tr.json is missing the mfa block').toBeDefined();
  });

  it('exposes the IDENTICAL mfa.* key paths in en and tr (no orphan on either side)', () => {
    const enKeys = flattenKeys(en, 'mfa');
    const trKeys = flattenKeys(tr, 'mfa');
    // A non-empty, equal key-set: any drift (a key added/removed on one side only) fails here.
    expect(enKeys.length).toBeGreaterThan(0);
    expect(trKeys).toEqual(enKeys);
  });

  it('has a non-empty string value for every mfa.* leaf in both languages', () => {
    const get = (root: unknown, path: string): unknown =>
      path.split('.').reduce<unknown>((acc, seg) => {
        if (acc !== null && typeof acc === 'object') {
          return (acc as Record<string, unknown>)[seg];
        }
        return undefined;
      }, root);

    // Walk the en key-set (parity with tr is proven above) and assert real copy on both sides.
    for (const path of flattenKeys(en)) {
      const enValue = get(en, path);
      const trValue = get(tr, path);
      expect(typeof enValue, `en mfa.${path} should be a string`).toBe('string');
      expect((enValue as string).length).toBeGreaterThan(0);
      expect(typeof trValue, `tr mfa.${path} should be a string`).toBe('string');
      expect((trValue as string).length).toBeGreaterThan(0);
    }
  });
});
