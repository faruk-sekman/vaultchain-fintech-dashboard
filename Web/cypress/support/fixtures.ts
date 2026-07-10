/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Pure (cy-free) seed data + response builders for the enterprise Cypress stubs. Everything here is
 * plain TypeScript so the SAME fixtures can be validated against `Api/openapi.json` from a Vitest
 * unit spec (src/app/testing/e2e-contract-fixtures.spec.ts) — the stubs and the contract check can
 * never drift apart silently. `enterprise-api.ts` imports from this module and only adds the
 * cy.intercept wiring.
 *
 * PII masking model (mirrors Api/src/common/util/mask.ts + customers.service.ts): customer
 * read surfaces are MASKED by default; raw values are returned only for `?reveal=true` requests from
 * a principal holding `customers.pii.reveal`. Dashboard latest/recent are ALWAYS masked
 * (MaskedCustomerDto has no reveal mode).
 */

// ---------------------------------------------------------------------------
// Permission matrices — mirror Api/scripts/seed-dev.ts ROLES exactly.
// ---------------------------------------------------------------------------

/** `administrator` role — everything, incl. reveal + delete + role/permission/user management. */
export const FULL_PERMISSIONS = [
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

/** `operator` ("Compliance Officer") — day-to-day ops; NO delete, NO PII reveal, NO admin mgmt. */
export const OPERATOR_PERMISSIONS = [
  'customers.read',
  'customers.manage',
  'wallets.read',
  'wallets.manage-limits',
  'transactions.read',
  'transactions.create',
  'kyc.read',
  'kyc.manage',
  'roles.read',
];

/** `auditor` ("Viewer") — read-only oversight. */
export const READ_ONLY_PERMISSIONS = [
  'customers.read',
  'wallets.read',
  'transactions.read',
  'kyc.read',
  'roles.read',
];

/** Role name → permission codes, for persona-matrix specs (mirrors the seeded RBAC roles). */
export const ROLE_PERMISSIONS: Record<'administrator' | 'operator' | 'auditor', string[]> = {
  administrator: FULL_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  auditor: READ_ONLY_PERMISSIONS,
};

// ---------------------------------------------------------------------------
// Wire types (subset of the backend DTOs the stubs emit).
// ---------------------------------------------------------------------------

export interface EnterpriseUser {
  id: string;
  displayName: string | null;
  email: string;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}

export interface BackendPage {
  number: number;
  size: number;
  totalItems: number;
  totalPages: number;
}

export type KycStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';
export type CustomerStatus = 'ACTIVE' | 'INACTIVE' | 'CLOSED';

/** RAW seed row — the stub's "database". Response mappers mask it unless reveal is effective. */
export interface BackendCustomer {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  walletNumber: string | null;
  nationalIdLast4: string | null;
  kycStatus: KycStatus;
  riskLevel: RiskLevel;
  status: CustomerStatus;
  createdAt: string;
  updatedAt: string;
  dateOfBirth: string | null;
  address: {
    country: string | null;
    city: string | null;
    postalCode: string | null;
    line1: string | null;
  };
  contractSigned: boolean;
  rowVersion: number;
}

export interface BackendWallet {
  id: string;
  currency: string;
  balanceMinor: string;
  availableBalanceMinor: string;
  dailyLimitMinor: string;
  monthlyLimitMinor: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  rowVersion: number;
}

export interface BackendTransaction {
  id: string;
  publicRef: string | null;
  kind: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'FEE' | 'ADJUSTMENT' | 'REVERSAL';
  status: 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
  amountMinor: string;
  currency: string;
  description: string | null;
  occurredAt: string;
  postedAt: string | null;
}

export interface AppNotification {
  id: string;
  type: 'SECURITY_ALERT' | 'KYC_EVENT' | 'CUSTOMER_EVENT' | 'SYSTEM' | 'ACCOUNT';
  severity: 'info' | 'success' | 'warning' | 'critical';
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown> | null;
  resourceType: string;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface RememberedDevice {
  id: string;
  createdAt: string;
  expiresAt: string;
  ipPrefix: string;
}

export const DEFAULT_USER: EnterpriseUser = {
  id: 'u-e2e-admin',
  displayName: 'E2E Administrator',
  email: 'admin@ftd.local',
  mfaEnabled: false,
  lastLoginAt: '2026-07-08T09:00:00.000Z',
};

// ---------------------------------------------------------------------------
// PII masking — replicates Api/src/common/util/mask.ts shapes exactly.
// ---------------------------------------------------------------------------

/** `Aylin Kaya` → `Aylin K***`; single token → `A***`; empty → `***`. */
export function maskName(name: string | null | undefined): string {
  if (!name) return '***';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  if (parts.length === 1) return `${parts[0][0]}***`;
  const [first, ...rest] = parts;
  return `${first} ${rest.map(p => `${p[0]}***`).join(' ')}`;
}

/** `aylin.kaya@example.com` → `a***@e***.com`. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  const domainName = dot >= 0 ? domain.slice(0, dot) : domain;
  return `${local[0]}***@${domainName[0] ?? ''}***${tld}`;
}

/** `+905551112233` → `*** *** 2233`; null stays null; <4 digits → `***`. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `*** *** ${digits.slice(-4)}`;
}

/** `TRW-C1` style values → `*`-padded last four characters. */
export function maskWalletNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return '***';
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

/** Street line → first character + `***` (city/postal are dropped to null by the detail mapper). */
export function maskAddressLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return '***';
  return `${trimmed[0]}***`;
}

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

export function seedCustomers(): BackendCustomer[] {
  return [
    customer('c-1', 'Aylin Kaya', 'aylin.kaya@example.com', 'VERIFIED', 'LOW', 'ACTIVE', 7),
    customer('c-2', 'Bora Demir', 'bora.demir@example.com', 'IN_REVIEW', 'MEDIUM', 'ACTIVE', 4),
    customer('c-3', 'Cem Arslan', 'cem.arslan@example.com', 'PENDING', 'MEDIUM', 'ACTIVE', 2),
    customer('c-4', 'Deniz Yilmaz', 'deniz.yilmaz@example.com', 'REJECTED', 'HIGH', 'INACTIVE', 5),
    customer('c-5', 'Ece Sahin', 'ece.sahin@example.com', 'VERIFIED', 'LOW', 'ACTIVE', 3),
    customer('c-6', 'Firat Celik', 'firat.celik@example.com', 'NOT_STARTED', 'MEDIUM', 'ACTIVE', 1),
    customer('c-7', 'Gizem Acar', 'gizem.acar@example.com', 'EXPIRED', 'HIGH', 'INACTIVE', 8),
    customer('c-8', 'Hakan Koc', 'hakan.koc@example.com', 'VERIFIED', 'LOW', 'ACTIVE', 6),
    customer('c-9', 'Irem Polat', 'irem.polat@example.com', 'IN_REVIEW', 'MEDIUM', 'ACTIVE', 2),
    customer('c-10', 'Kerem Oz', 'kerem.oz@example.com', 'VERIFIED', 'LOW', 'ACTIVE', 2),
    customer('c-11', 'Leyla Er', 'leyla.er@example.com', 'PENDING', 'MEDIUM', 'ACTIVE', 1),
    customer('c-12', 'Mert Aksoy', 'mert.aksoy@example.com', 'VERIFIED', 'BLOCKED', 'CLOSED', 9),
  ];
}

function customer(
  id: string,
  fullName: string,
  email: string,
  kycStatus: KycStatus,
  riskLevel: RiskLevel,
  status: CustomerStatus,
  rowVersion: number,
): BackendCustomer {
  return {
    id,
    fullName,
    email,
    phone: '+905551112233',
    walletNumber: `TRW-${id.toUpperCase().replace('-', '')}`,
    nationalIdLast4: '0146',
    kycStatus,
    riskLevel,
    status,
    createdAt: '2025-01-12T10:00:00.000Z',
    updatedAt: '2026-07-08T09:00:00.000Z',
    dateOfBirth: '1990-01-01',
    address: {
      country: 'Turkiye',
      city: 'Istanbul',
      postalCode: '34000',
      line1: 'Maslak Mahallesi Buyukdere Caddesi 1',
    },
    contractSigned: true,
    rowVersion,
  };
}

export function seedWallet(): BackendWallet {
  return {
    id: 'w-c-1',
    currency: 'TRY',
    balanceMinor: '5810000',
    availableBalanceMinor: '5810000',
    dailyLimitMinor: '500000',
    monthlyLimitMinor: '1500000',
    status: 'ACTIVE',
    rowVersion: 3,
  };
}

export function seedTransactions(): BackendTransaction[] {
  return [
    {
      id: 'tx-1',
      publicRef: 'TRX-001',
      kind: 'DEPOSIT',
      status: 'POSTED',
      amountMinor: '125000',
      currency: 'TRY',
      description: 'Initial salary credit',
      occurredAt: '2026-07-08T08:45:00.000Z',
      postedAt: '2026-07-08T08:45:30.000Z',
    },
    {
      id: 'tx-2',
      publicRef: 'TRX-002',
      kind: 'WITHDRAWAL',
      status: 'POSTED',
      amountMinor: '-42000',
      currency: 'TRY',
      description: 'ATM withdrawal',
      occurredAt: '2026-07-07T14:20:00.000Z',
      postedAt: '2026-07-07T14:20:30.000Z',
    },
  ];
}

export function seedNotifications(): AppNotification[] {
  return [
    {
      id: 'notif-1',
      type: 'KYC_EVENT',
      severity: 'warning',
      titleKey: 'notifications.kyc.statusChanged.title',
      bodyKey: 'notifications.kyc.statusChanged.body',
      params: null,
      resourceType: 'customer',
      resourceId: 'c-1',
      readAt: null,
      createdAt: '2026-07-08T09:15:00.000Z',
    },
    {
      id: 'notif-2',
      type: 'SECURITY_ALERT',
      severity: 'critical',
      titleKey: 'notifications.security.newTrustedDevice.title',
      bodyKey: 'notifications.security.newTrustedDevice.body',
      params: null,
      resourceType: 'customer',
      resourceId: 'c-2',
      readAt: '2026-07-08T09:20:00.000Z',
      createdAt: '2026-07-08T08:45:00.000Z',
    },
    {
      id: 'notif-3',
      type: 'SYSTEM',
      severity: 'info',
      titleKey: 'notifications.fallback.title',
      bodyKey: 'notifications.fallback.body',
      params: null,
      resourceType: 'system',
      resourceId: null,
      readAt: null,
      createdAt: '2026-07-07T11:00:00.000Z',
    },
  ];
}

export function seedTrustedDevices(): RememberedDevice[] {
  return [
    {
      id: 'td-1',
      ipPrefix: '10.24.8.0/24',
      createdAt: '2026-07-01T09:00:00.000Z',
      expiresAt: '2026-08-01T09:00:00.000Z',
    },
    {
      id: 'td-2',
      ipPrefix: '10.30.12.0/24',
      createdAt: '2026-07-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:00:00.000Z',
    },
  ];
}

// ---------------------------------------------------------------------------
// Response builders (wire envelopes + DTO mappers).
// ---------------------------------------------------------------------------

/** Error envelope exactly as `all-exceptions.filter.ts` emits it. */
export function errorEnvelope(
  code: string,
  message: string,
  correlationId: string,
  details?: unknown,
): { error: { code: string; message: string; correlationId: string; details?: unknown } } {
  return {
    error:
      details === undefined
        ? { code, message, correlationId }
        : { code, message, correlationId, details },
  };
}

export function pageMeta(page: number, pageSize: number, total: number): BackendPage {
  return {
    number: page,
    size: pageSize,
    totalItems: total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** CustomerListItemDto — masked unless the reveal decision is effective. */
export function toCustomerListItem(c: BackendCustomer, reveal: boolean): Record<string, unknown> {
  return {
    id: c.id,
    fullName: reveal ? c.fullName : maskName(c.fullName),
    email: reveal ? c.email : maskEmail(c.email),
    phone: reveal ? c.phone : maskPhone(c.phone),
    walletNumber: reveal ? c.walletNumber : maskWalletNumber(c.walletNumber),
    nationalIdLast4: c.nationalIdLast4, // last-4 in BOTH modes; full id is never served
    kycStatus: c.kycStatus,
    riskLevel: c.riskLevel,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** CustomerDetailDto — address masking: country raw, city/postal → null, line1 → first char. */
export function toCustomerDetail(c: BackendCustomer, reveal: boolean): Record<string, unknown> {
  return {
    ...toCustomerListItem(c, reveal),
    dateOfBirth: c.dateOfBirth,
    address: {
      country: c.address.country,
      city: reveal ? c.address.city : null,
      postalCode: reveal ? c.address.postalCode : null,
      line1: reveal ? c.address.line1 : maskAddressLine(c.address.line1),
    },
    contractSigned: c.contractSigned,
    rowVersion: c.rowVersion,
  };
}

/** MaskedCustomerDto (dashboard latest/recent) — ALWAYS masked; risk enum is UPPERCASE. */
export function toDashboardCustomer(c: BackendCustomer): Record<string, unknown> {
  return {
    id: c.id,
    fullName: maskName(c.fullName),
    email: maskEmail(c.email),
    phone: maskPhone(c.phone),
    kycStatus: c.kycStatus,
    status: c.status,
    riskLevel: c.riskLevel,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Full LoginResponseDto (`/auth/login` authenticated branch AND `/auth/refresh`). */
export function buildLoginResponse(
  permissions: string[],
  user: EnterpriseUser,
  accessToken = 'e2e-access-token',
): Record<string, unknown> {
  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 900,
    permissions,
    user,
  };
}

/** DashboardSummaryDto with rates CONSISTENT with the seed's active/inactive split. */
export function buildDashboardSummary(
  customers: readonly BackendCustomer[],
): Record<string, unknown> {
  const total = customers.length;
  const active = customers.filter(c => c.status === 'ACTIVE').length;
  const rate = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  return {
    totalCustomers: total,
    activeCount: active,
    inactiveCount: total - active,
    activeRate: rate(active),
    inactiveRate: rate(total - active),
    ageStats: { avg: 36, min: 24, max: 58 },
    asOf: new Date().toISOString(),
  };
}

/** UserListItemDto rows for `/users` (paginated: `{ data, page }`). */
export function seedUserList(): Record<string, unknown>[] {
  return [
    {
      id: 'u-target',
      displayName: 'Target Operator',
      status: 'ACTIVE',
      roles: ['operator'],
      emailMasked: 't***@f***.local',
      locked: false,
      failedLoginCount: 0,
      lastLoginAt: '2026-07-08T08:00:00.000Z',
    },
  ];
}

// ---------------------------------------------------------------------------
// Stub inventory — every (method, path-template) enterprise-api.ts intercepts.
// Validated against Api/openapi.json `paths` by e2e-contract-fixtures.spec.ts.
// ---------------------------------------------------------------------------

export const STUBBED_ENDPOINTS: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'post', path: '/api/v1/auth/login' },
  { method: 'post', path: '/api/v1/auth/refresh' },
  { method: 'get', path: '/api/v1/auth/me' },
  { method: 'post', path: '/api/v1/auth/logout' },
  { method: 'post', path: '/api/v1/auth/mfa/verify' },
  { method: 'post', path: '/api/v1/auth/mfa/backup-code/verify' },
  { method: 'post', path: '/api/v1/auth/mfa/setup/start' },
  { method: 'post', path: '/api/v1/auth/mfa/setup/confirm' },
  { method: 'post', path: '/api/v1/auth/mfa/disable' },
  { method: 'post', path: '/api/v1/auth/mfa/backup-codes/regenerate' },
  { method: 'get', path: '/api/v1/auth/mfa/devices' },
  { method: 'delete', path: '/api/v1/auth/mfa/devices/{id}' },
  { method: 'get', path: '/api/v1/operator/profile' },
  { method: 'patch', path: '/api/v1/operator/profile' },
  { method: 'get', path: '/api/v1/operator/notification-preferences' },
  { method: 'patch', path: '/api/v1/operator/notification-preferences' },
  { method: 'get', path: '/api/v1/operator/notifications' },
  { method: 'post', path: '/api/v1/operator/notifications/read-all' },
  { method: 'post', path: '/api/v1/operator/notifications/{id}/read' },
  { method: 'get', path: '/api/v1/health' },
  { method: 'post', path: '/api/v1/dashboard/stream-token' },
  { method: 'get', path: '/api/v1/dashboard/summary' },
  { method: 'get', path: '/api/v1/dashboard/kyc-distribution' },
  { method: 'get', path: '/api/v1/dashboard/latest-customer' },
  { method: 'get', path: '/api/v1/dashboard/recent-customers' },
  { method: 'get', path: '/api/v1/metrics/daily' },
  { method: 'get', path: '/api/v1/catalog/currencies' },
  { method: 'get', path: '/api/v1/customers' },
  { method: 'post', path: '/api/v1/customers' },
  { method: 'get', path: '/api/v1/customers/{id}' },
  { method: 'put', path: '/api/v1/customers/{id}' },
  { method: 'delete', path: '/api/v1/customers/{id}' },
  { method: 'get', path: '/api/v1/customers/{id}/wallet' },
  { method: 'patch', path: '/api/v1/customers/{id}/wallet' },
  { method: 'get', path: '/api/v1/customers/{id}/transactions' },
  { method: 'get', path: '/api/v1/customers/{id}/kyc-verifications' },
  { method: 'get', path: '/api/v1/customers/{id}/risk-assessments' },
  { method: 'get', path: '/api/v1/customers/{id}/credential-preview' },
  { method: 'post', path: '/api/v1/transactions' },
  { method: 'get', path: '/api/v1/roles' },
  { method: 'get', path: '/api/v1/permissions' },
  { method: 'get', path: '/api/v1/users' },
];
