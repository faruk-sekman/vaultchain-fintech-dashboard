/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Contract-fidelity gate for the Cypress stub fixtures (cypress/support/fixtures.ts) against the
 * committed backend contract (Api/openapi.json). Hand-rolled on purpose — no schema-validator
 * dependency: for each fixture family we check the schema's REQUIRED keys are present, enum values
 * are members, and non-nullable primitives carry the right runtime type (additive-tolerant: extra
 * fields and nullable/`object`-typed properties are not over-constrained). It also pins every
 * stubbed (method, path-template) to a real openapi path, so a stub can't outlive its endpoint.
 */
import { describe, expect, it } from 'vitest';

import openapi from '../../../../Api/openapi.json';
import {
  FULL_PERMISSIONS,
  DEFAULT_USER,
  STUBBED_ENDPOINTS,
  buildDashboardSummary,
  buildLoginResponse,
  errorEnvelope,
  maskAddressLine,
  maskEmail,
  maskName,
  maskPhone,
  maskWalletNumber,
  pageMeta,
  seedCustomers,
  seedNotifications,
  seedTransactions,
  seedTrustedDevices,
  seedUserList,
  seedWallet,
  toCustomerDetail,
  toCustomerListItem,
  toDashboardCustomer,
} from '../../../cypress/support/fixtures';

type Schema = {
  type?: string;
  enum?: unknown[];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, Schema>;
  $ref?: string;
  allOf?: Schema[];
};

const schemas = (openapi as { components: { schemas: Record<string, Schema> } }).components.schemas;
const paths = (openapi as { paths: Record<string, Record<string, unknown>> }).paths;

function resolve(schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop() ?? '';
    return schemas[name] ?? {};
  }
  if (schema.allOf?.length) return resolve(schema.allOf[0]);
  return schema;
}

/** Assert `value` satisfies the named component schema (entry point). */
function expectMatchesSchema(value: Record<string, unknown>, schemaName: string): void {
  expectMatches(value, schemas[schemaName], schemaName);
}

/** Required keys present, enum values are members, non-nullable primitives typed; recurses into $ref'd objects. */
function expectMatches(
  value: Record<string, unknown>,
  schema: Schema | undefined,
  label: string,
): void {
  expect(schema, `schema ${label} exists in openapi.json`).toBeDefined();
  for (const key of schema?.required ?? []) {
    expect(Object.hasOwn(value, key), `${label}.${key} present`).toBe(true);
    const raw = schema?.properties?.[key] ?? {};
    const prop = resolve(raw);
    const actual = value[key];
    if (actual === null) {
      expect(raw.nullable ?? prop.nullable, `${label}.${key} may be null`).toBe(true);
      continue;
    }
    if (prop.enum) {
      expect(prop.enum, `${label}.${key} enum member`).toContain(actual);
      continue;
    }
    if (prop.type === 'string') expect(typeof actual, `${label}.${key} string`).toBe('string');
    if (prop.type === 'number') expect(typeof actual, `${label}.${key} number`).toBe('number');
    if (prop.type === 'boolean') expect(typeof actual, `${label}.${key} boolean`).toBe('boolean');
    if (prop.type === 'array') expect(Array.isArray(actual), `${label}.${key} array`).toBe(true);
    if (prop.properties && typeof actual === 'object' && !Array.isArray(actual)) {
      expectMatches(actual as Record<string, unknown>, prop, `${label}.${key}`);
    }
  }
}

describe('e2e stub fixtures vs Api/openapi.json', () => {
  it('customer fixtures satisfy CustomerListItemDto/CustomerDetailDto in masked AND revealed modes', () => {
    for (const customer of seedCustomers()) {
      for (const reveal of [false, true]) {
        expectMatchesSchema(toCustomerListItem(customer, reveal), 'CustomerListItemDto');
        const detail = toCustomerDetail(customer, reveal);
        expectMatchesSchema(detail, 'CustomerDetailDto');
        expectMatchesSchema(detail.address as Record<string, unknown>, 'AddressDto');
      }
      expectMatchesSchema(toDashboardCustomer(customer), 'MaskedCustomerDto');
    }
  });

  it('masked shapes replicate the backend mask.ts exactly (incl. guard branches)', () => {
    const masked = toCustomerListItem(seedCustomers()[0], false);
    expect(masked.fullName).toBe('Aylin K***');
    expect(masked.email).toBe('a***@e***.com');
    expect(masked.phone).toBe('*** *** 2233');
    expect(masked.walletNumber).toBe('**W-C1');
    expect(masked.nationalIdLast4).toBe('0146'); // last-4 in BOTH modes; never the full id
    const detail = toCustomerDetail(seedCustomers()[0], false);
    expect((detail.address as Record<string, unknown>).city).toBeNull();
    expect((detail.address as Record<string, unknown>).postalCode).toBeNull();
    expect((detail.address as Record<string, unknown>).line1).toBe('M***');

    // Guard branches, mirrored from Api/src/common/util/mask.ts.
    expect(maskName(null)).toBe('***');
    expect(maskName('  ')).toBe('***');
    expect(maskName('Ada')).toBe('A***');
    expect(maskEmail(null)).toBe('***');
    expect(maskEmail('@nolocal')).toBe('***');
    expect(maskEmail('nodomain@')).toBe('***');
    expect(maskEmail('a@host')).toBe('a***@h***');
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone('12')).toBe('***');
    expect(maskWalletNumber(null)).toBeNull();
    expect(maskWalletNumber('abc')).toBe('***');
    expect(maskWalletNumber('1234567890')).toBe('******7890');
    expect(maskAddressLine(null)).toBeNull();
    expect(maskAddressLine('   ')).toBe('***');
    expect(maskAddressLine('Sokak 1')).toBe('S***');
  });

  it('wallet / transaction / notification / device fixtures satisfy their DTO schemas', () => {
    expectMatchesSchema(seedWallet() as unknown as Record<string, unknown>, 'WalletDetailDto');
    for (const tx of seedTransactions()) {
      expectMatchesSchema(tx as unknown as Record<string, unknown>, 'TransactionListItemDto');
    }
    for (const item of seedNotifications()) {
      expectMatchesSchema(item as unknown as Record<string, unknown>, 'NotificationItemDto');
    }
    for (const device of seedTrustedDevices()) {
      expectMatchesSchema(device as unknown as Record<string, unknown>, 'RememberedDeviceDto');
    }
    for (const user of seedUserList()) {
      expectMatchesSchema(user, 'UserListItemDto');
    }
  });

  it('auth + dashboard builders satisfy LoginResponseDto / MeUserDto / DashboardSummaryDto', () => {
    const login = buildLoginResponse(FULL_PERMISSIONS, DEFAULT_USER);
    expectMatchesSchema(login, 'LoginResponseDto');
    expectMatchesSchema(login.user as Record<string, unknown>, 'MeUserDto');
    expect(buildLoginResponse(FULL_PERMISSIONS, DEFAULT_USER, 'other-token').accessToken).toBe(
      'other-token',
    );

    const summary = buildDashboardSummary(seedCustomers());
    expectMatchesSchema(summary, 'DashboardSummaryDto');
    // Rates must stay CONSISTENT with the seed's active/inactive split (sum to ~100).
    const active = seedCustomers().filter(c => c.status === 'ACTIVE').length;
    expect(summary.activeCount).toBe(active);
    expect((summary.activeRate as number) + (summary.inactiveRate as number)).toBeCloseTo(100, 1);
    expect(buildDashboardSummary([]).activeRate).toBe(0);
  });

  it('error envelope and page meta match the wire format', () => {
    expect(errorEnvelope('Wallets.Conflict', 'msg', 'corr-1')).toEqual({
      error: { code: 'Wallets.Conflict', message: 'msg', correlationId: 'corr-1' },
    });
    expect(
      errorEnvelope('Validation.Failed', 'msg', 'corr-2', [{ field: 'x' }]).error.details,
    ).toEqual([{ field: 'x' }]);
    expect(pageMeta(2, 10, 12)).toEqual({ number: 2, size: 10, totalItems: 12, totalPages: 2 });
    expect(pageMeta(1, 10, 0).totalPages).toBe(1);
  });

  it('every stubbed (method, path-template) exists in openapi.json paths', () => {
    for (const { method, path } of STUBBED_ENDPOINTS) {
      const entry = paths[path];
      expect(entry, `openapi path ${path}`).toBeDefined();
      expect(Object.keys(entry), `${method.toUpperCase()} ${path}`).toContain(method);
    }
  });
});
