/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Contract smoke validators for Cypress. They intentionally assert the public response shape instead
 * of duplicating every backend DTO field, so the tests catch drift while staying resilient to additive
 * enterprise API changes.
 */

export type ApiContract =
  | 'auth.session'
  | 'auth.refresh'
  | 'auth.principal'
  | 'customer.page'
  | 'customer.detail'
  | 'wallet.detail'
  | 'transaction.page'
  | 'transaction.create'
  | 'notification.page'
  | 'operator.profile'
  | 'operator.notificationPreferences'
  | 'health';

export function expectContract(contract: ApiContract, body: unknown): void {
  switch (contract) {
    case 'auth.session':
      expectAuthSession(body);
      break;
    case 'auth.refresh':
      expectAuthRefresh(body);
      break;
    case 'auth.principal':
      expectAuthPrincipal(body);
      break;
    case 'customer.page':
      expectCustomerPage(body);
      break;
    case 'customer.detail':
      expectCustomerDetail(body);
      break;
    case 'wallet.detail':
      expectWalletDetail(body);
      break;
    case 'transaction.page':
      expectTransactionPage(body);
      break;
    case 'transaction.create':
      expectTransactionCreate(body);
      break;
    case 'notification.page':
      expectNotificationPage(body);
      break;
    case 'operator.profile':
      expectOperatorProfile(body);
      break;
    case 'operator.notificationPreferences':
      expectNotificationPreferences(body);
      break;
    case 'health':
      expectHealth(body);
      break;
  }
}

export function expectAliasContract(alias: string, contract: ApiContract, attempts = 2): void {
  cy.wait(alias).then(interception => {
    if (!interception.response && attempts > 1) {
      expectAliasContract(alias, contract, attempts - 1);
      return;
    }
    expect(interception.response, `${alias} response`).to.exist;
    expect(interception.response?.statusCode, `${alias} status`).to.be.within(200, 299);
    expectContract(contract, interception.response?.body);
  });
}

function expectAuthSession(body: unknown): void {
  const data = dataRecord(body, 'auth session data');
  expect(data.status, 'status').to.be.oneOf(['authenticated', 'mfa_required']);
  if (data.status === 'authenticated') {
    expectString(data, 'accessToken');
    expect(data.tokenType, 'tokenType').to.eq('Bearer');
    expectNumber(data, 'expiresIn');
    expectStringArray(data, 'permissions');
    expectUser(data.user);
  }
}

function expectAuthRefresh(body: unknown): void {
  // The real `/auth/refresh` answers the FULL LoginResponseDto (rotated token + principal snapshot).
  const data = dataRecord(body, 'refresh data');
  expectString(data, 'accessToken');
  expect(data.tokenType, 'tokenType').to.eq('Bearer');
  expectNumber(data, 'expiresIn');
  expectStringArray(data, 'permissions');
  expectUser(data.user);
}

function expectAuthPrincipal(body: unknown): void {
  const data = dataRecord(body, 'principal data');
  expectUser(data.user);
  expectStringArray(data, 'permissions');
}

function expectCustomerPage(body: unknown): void {
  const envelope = record(body, 'customer page envelope');
  const rows = array(envelope.data, 'customer page data');
  rows.forEach(row => expectCustomerListItem(row));
  expectPage(envelope.page);
}

function expectCustomerDetail(body: unknown): void {
  expectCustomerDetailItem(dataRecord(body, 'customer detail'));
}

function expectWalletDetail(body: unknown): void {
  const data = dataRecord(body, 'wallet detail');
  expectString(data, 'id');
  expectString(data, 'currency');
  expectString(data, 'balanceMinor');
  expectString(data, 'availableBalanceMinor');
  expectString(data, 'dailyLimitMinor');
  expectString(data, 'monthlyLimitMinor');
  expect(data.status, 'wallet status').to.be.oneOf(['ACTIVE', 'FROZEN', 'CLOSED']);
  expectNumber(data, 'rowVersion');
}

function expectTransactionPage(body: unknown): void {
  const envelope = record(body, 'transaction page envelope');
  const rows = array(envelope.data, 'transaction page data');
  rows.forEach(expectTransaction);
  expectPage(envelope.page);
}

function expectTransactionCreate(body: unknown): void {
  const data = dataRecord(body, 'created transaction');
  expectString(data, 'id');
  expect(data.status, 'transaction status').to.be.oneOf([
    'PENDING',
    'POSTED',
    'FAILED',
    'REVERSED',
  ]);
  expectString(data, 'amountMinor');
  expectString(data, 'currency');
}

function expectNotificationPage(body: unknown): void {
  const envelope = record(body, 'notification page envelope');
  const rows = array(envelope.data, 'notification page data');
  rows.forEach(expectNotification);
  expectPage(envelope.page);
  expectNumber(envelope, 'unreadCount');
}

function expectOperatorProfile(body: unknown): void {
  // OperatorProfileDto: displayName, phone and jobTitle are all nullable on the real wire.
  const data = dataRecord(body, 'operator profile');
  expect(data.displayName, 'displayName').to.satisfy(isNullableString);
  expectString(data, 'email');
  expect(data.phone, 'phone').to.satisfy(isNullableString);
  expect(data.jobTitle, 'jobTitle').to.satisfy(isNullableString);
}

function expectNotificationPreferences(body: unknown): void {
  const data = dataRecord(body, 'notification preferences');
  expectBoolean(data, 'productUpdates');
  expectBoolean(data, 'securityAlerts');
  expectBoolean(data, 'weeklyDigest');
}

function expectHealth(body: unknown): void {
  const data = dataRecord(body, 'health');
  expectString(data, 'status');
}

function expectCustomerListItem(value: unknown): void {
  const item = record(value, 'customer list item');
  expectString(item, 'id');
  expectString(item, 'fullName');
  expectString(item, 'email');
  expect(item.phone, 'phone').to.satisfy(isNullableString);
  expect(item.walletNumber, 'walletNumber').to.satisfy(isNullableString);
  expect(item.nationalIdLast4, 'nationalIdLast4').to.satisfy(isNullableString);
  expect(item.kycStatus, 'kycStatus').to.be.oneOf([
    'NOT_STARTED',
    'PENDING',
    'IN_REVIEW',
    'VERIFIED',
    'REJECTED',
    'EXPIRED',
  ]);
  expect(item.riskLevel, 'riskLevel').to.be.oneOf(['LOW', 'MEDIUM', 'HIGH', 'BLOCKED']);
  expect(item.status, 'customer status').to.be.oneOf(['ACTIVE', 'INACTIVE', 'CLOSED']);
  expectString(item, 'createdAt');
  expectString(item, 'updatedAt');
}

function expectCustomerDetailItem(value: unknown): void {
  expectCustomerListItem(value);
  const item = record(value, 'customer detail item');
  expect(item.dateOfBirth, 'dateOfBirth').to.satisfy(isNullableString);
  expect(item.contractSigned, 'contractSigned').to.be.a('boolean');
  expectNumber(item, 'rowVersion');
  const address = record(item.address, 'address');
  expect(address.country, 'address.country').to.satisfy(isNullableString);
  expect(address.city, 'address.city').to.satisfy(isNullableString);
  expect(address.postalCode, 'address.postalCode').to.satisfy(isNullableString);
  expect(address.line1, 'address.line1').to.satisfy(isNullableString);
}

function expectTransaction(value: unknown): void {
  const item = record(value, 'transaction');
  expectString(item, 'id');
  expect(item.publicRef, 'publicRef').to.satisfy(isNullableString);
  expect(item.kind, 'kind').to.be.oneOf([
    'DEPOSIT',
    'WITHDRAWAL',
    'TRANSFER',
    'FEE',
    'ADJUSTMENT',
    'REVERSAL',
  ]);
  expect(item.status, 'status').to.be.oneOf(['PENDING', 'POSTED', 'FAILED', 'REVERSED']);
  expectString(item, 'amountMinor');
  expectString(item, 'currency');
  expect(item.description, 'description').to.satisfy(isNullableString);
  expectString(item, 'occurredAt');
  expect(item.postedAt, 'postedAt').to.satisfy(isNullableString);
}

function expectNotification(value: unknown): void {
  const item = record(value, 'notification');
  expectString(item, 'id');
  expectString(item, 'type');
  expect(item.severity, 'severity').to.be.oneOf(['info', 'success', 'warning', 'critical']);
  expectString(item, 'titleKey');
  expectString(item, 'bodyKey');
  expectString(item, 'resourceType');
  expect(item.resourceId, 'resourceId').to.satisfy(isNullableString);
  expect(item.readAt, 'readAt').to.satisfy(isNullableString);
  expectString(item, 'createdAt');
}

function expectUser(value: unknown): void {
  const user = record(value, 'user');
  expectString(user, 'id');
  expect(user.displayName, 'displayName').to.satisfy(isNullableString);
  expectString(user, 'email');
  expectBoolean(user, 'mfaEnabled');
  // MeUserDto requires the key (nullable value) — the Settings "last sign-in" readout depends on it.
  expect('lastLoginAt' in user, 'lastLoginAt key').to.eq(true);
  expect(user.lastLoginAt, 'lastLoginAt').to.satisfy(isNullableString);
}

function expectPage(value: unknown): void {
  const page = record(value, 'page');
  expectNumber(page, 'number');
  expectNumber(page, 'size');
  expectNumber(page, 'totalItems');
  expectNumber(page, 'totalPages');
}

function dataRecord(body: unknown, label: string): Record<string, unknown> {
  const envelope = record(body, `${label} envelope`);
  return record(envelope.data, label);
}

function record(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).to.be.an('object').and.not.be.null;
  expect(Array.isArray(value), `${label} is not an array`).to.eq(false);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  expect(value, label).to.be.an('array');
  return value as unknown[];
}

function expectString(value: Record<string, unknown>, key: string): void {
  expect(value[key], key).to.be.a('string').and.not.eq('');
}

function expectStringArray(value: Record<string, unknown>, key: string): void {
  expect(value[key], key).to.be.an('array');
  (value[key] as unknown[]).forEach(item => expect(item, `${key} item`).to.be.a('string'));
}

function expectNumber(value: Record<string, unknown>, key: string): void {
  expect(value[key], key).to.be.a('number');
}

function expectBoolean(value: Record<string, unknown>, key: string): void {
  expect(value[key], key).to.be.a('boolean');
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}
