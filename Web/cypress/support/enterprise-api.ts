/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Enterprise Cypress API stubs. Seeds + response builders live in the cy-free `fixtures.ts` (they are
 * contract-checked against Api/openapi.json by a Vitest spec); this module adds the cy.intercept
 * wiring and mutable per-test state. Wire fidelity mirrors the real backend:
 *  - success `{ data, meta: { correlationId } }`, lists `{ data, page, meta }`;
 *  - errors `{ error: { code, message, correlationId } }`;
 *  - customer read surfaces MASKED by default, raw only for `?reveal=true`;
 *  - wallet PATCH is rowVersion-guarded (stale submit → 409 `Wallets.Conflict`, like
 *    wallets.service.ts) and MFA device revoke is ALWAYS 204 (idempotent, like
 *    remembered-device.service.ts — there is no "already revoked" error on the real wire).
 */

import {
  AppNotification,
  BackendCustomer,
  BackendPage,
  BackendTransaction,
  DEFAULT_USER,
  EnterpriseUser,
  FULL_PERMISSIONS,
  buildDashboardSummary,
  buildLoginResponse,
  errorEnvelope,
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
} from './fixtures';

export {
  FULL_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
} from './fixtures';

interface EnterpriseApiOptions {
  permissions?: string[];
  user?: Partial<EnterpriseUser>;
  mfaEnabled?: boolean;
  loginRequiresMfa?: boolean;
  refreshSucceeds?: boolean;
}

/**
 * Test-side controller over the stub's mutable state, returned by {@link stubEnterpriseApi}.
 * `bumpWalletVersion` simulates ANOTHER operator changing the wallet out-of-band: the stored
 * rowVersion advances (and the limits shift), so the app's NEXT save with its stale rowVersion
 * legitimately 409s — and keeps 409ing until it re-fetches, exactly like the real backend.
 */
export interface EnterpriseApiController {
  bumpWalletVersion(): void;
}

interface VisitEnterpriseOptions {
  language?: 'en' | 'tr';
  sessionHint?: boolean;
  theme?: 'light' | 'dark';
  sidebarCollapsed?: boolean;
}

type RouteRequest = {
  url: string;
  alias?: string;
  reply: (...args: any[]) => void;
};

const CORR = 'e2e-corr';

/** Success envelope for single resources: `{ data, meta: { correlationId } }`. */
function dataBody<T>(data: T): { data: T; meta: { correlationId: string } } {
  return { data, meta: { correlationId: CORR } };
}

/** Success envelope for lists: `{ data, page, meta }` (+ optional extras like unreadCount). */
function listBody<T>(
  rows: T[],
  page: BackendPage,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { data: rows, page, meta: { correlationId: CORR }, ...extra };
}

export function visitEnterprise(path: string, options: VisitEnterpriseOptions = {}): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      installNoopEventSource(win);
      win.localStorage.setItem('lang', options.language ?? 'en');
      if (options.theme) {
        win.localStorage.setItem('theme-mode', options.theme);
        win.localStorage.setItem('theme', options.theme);
      }
      if (options.sidebarCollapsed != null) {
        win.localStorage.setItem('sidebar-collapsed', options.sidebarCollapsed ? '1' : '0');
      }
      if (options.sessionHint) win.localStorage.setItem('ftd_session', '1');
    },
  });
}

export function loginEnterprise(options: EnterpriseApiOptions = {}): EnterpriseApiController {
  const controller = stubEnterpriseApi(options);
  visitEnterprise('/login');
  cy.byTestId('login-email').clear().type('admin@ftd.local');
  cy.byTestId('login-password').clear().type('Passw0rd!', { log: false });
  cy.byTestId('login-submit').click();
  cy.wait('@login');
  if (options.loginRequiresMfa) {
    cy.url().should('include', '/mfa/verify');
  } else {
    cy.url().should('include', '/dashboard');
  }
  return controller;
}

export function stubEnterpriseApi(options: EnterpriseApiOptions = {}): EnterpriseApiController {
  let mfaEnabled = options.mfaEnabled ?? false;
  const permissions = options.permissions ?? FULL_PERMISSIONS;
  const user = (): EnterpriseUser => ({
    ...DEFAULT_USER,
    ...options.user,
    mfaEnabled,
  });

  let profile = {
    displayName: user().displayName,
    email: 'admin@ftd.local',
    phone: '+905551110000',
    jobTitle: 'Operations Lead',
  };
  let notificationPreferences = {
    productUpdates: true,
    securityAlerts: true,
    weeklyDigest: false,
  };
  let customers = seedCustomers();
  let wallet = seedWallet();
  let transactions = seedTransactions();
  let notifications = seedNotifications();
  let trustedDevices = seedTrustedDevices();

  const authData = () => ({
    status: 'authenticated' as const,
    ...buildLoginResponse(permissions, user()),
  });
  const principal = () => ({ user: user(), permissions });
  /** EFFECTIVE reveal for customer read surfaces: `?reveal=true` asked AND the permission held. */
  const revealEffective = (url: string): boolean =>
    new URL(url).searchParams.get('reveal') === 'true' &&
    permissions.includes('customers.pii.reveal');

  // Catch-all LAST resort (specific stubs below override it): an UNSTUBBED api read is a contract
  // gap in the spec, so answer 404 with a real error envelope and leave a console trace instead of
  // silently feeding the app an empty page.
  cy.intercept('GET', '**/api/v1/**', req => {
    // eslint-disable-next-line no-console
    console.warn(`[enterprise-api] Unstubbed GET → 404: ${req.url} (add an explicit stub)`);
    req.reply({
      statusCode: 404,
      body: errorEnvelope('Resource.NotFound', `No stub for ${new URL(req.url).pathname}.`, CORR),
    });
  });

  cy.intercept('POST', '**/api/v1/auth/login', req => {
    req.alias = 'login';
    if (options.loginRequiresMfa) {
      req.reply({ statusCode: 200, body: dataBody({ status: 'mfa_required' }) });
      return;
    }
    req.reply({ statusCode: 200, body: dataBody(authData()) });
  });

  cy.intercept('POST', '**/api/v1/auth/refresh', req => {
    req.alias = 'refreshSession';
    if (options.refreshSucceeds === false) {
      req.reply({
        statusCode: 401,
        body: errorEnvelope('Auth.TokenMissing', 'No session found. Please sign in.', CORR),
      });
      return;
    }
    // The real refresh returns the FULL LoginResponseDto (rotated token + principal snapshot).
    req.reply({
      statusCode: 200,
      body: dataBody(buildLoginResponse(permissions, user(), 'e2e-refresh-access-token')),
    });
  });

  cy.intercept('GET', '**/api/v1/auth/me', req => {
    req.alias = 'authMe';
    req.reply({ statusCode: 200, body: dataBody(principal()) });
  });

  cy.intercept('POST', '**/api/v1/auth/logout', req => {
    req.alias = 'logout';
    req.reply({ statusCode: 204, body: null });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/verify', req => {
    req.alias = 'mfaVerify';
    mfaEnabled = true;
    req.reply({ statusCode: 200, body: dataBody(authData()) });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/backup-code/verify', req => {
    req.alias = 'mfaBackupVerify';
    mfaEnabled = true;
    req.reply({ statusCode: 200, body: dataBody(authData()) });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/setup/start', req => {
    req.alias = 'mfaSetupStart';
    req.reply({
      statusCode: 200,
      body: dataBody({
        otpauthUri: 'otpauth://totp/FintechDashboard:e2e?secret=E2ESECRET&issuer=FintechDashboard',
        qrDataUrl:
          'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxODAiIGhlaWdodD0iMTgwIj48cmVjdCB3aWR0aD0iMTgwIiBoZWlnaHQ9IjE4MCIgZmlsbD0iI2ZmZiIvPjxyZWN0IHg9IjI0IiB5PSIyNCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMTExIi8+PHJlY3QgeD0iMTA4IiB5PSIyNCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMTExIi8+PHJlY3QgeD0iMjQiIHk9IjEwOCIgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMTExIi8+PC9zdmc+',
      }),
    });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/setup/confirm', req => {
    req.alias = 'mfaSetupConfirm';
    mfaEnabled = true;
    req.reply({
      statusCode: 200,
      body: dataBody({ backupCodes: ['ABCD1-EFGH2', 'IJKL3-MNOP4', 'QRST5-UVWX6'] }),
    });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/disable', req => {
    req.alias = 'mfaDisable';
    mfaEnabled = false;
    req.reply({ statusCode: 204, body: null });
  });

  cy.intercept('POST', '**/api/v1/auth/mfa/backup-codes/regenerate', req => {
    req.alias = 'mfaRegenerateBackupCodes';
    req.reply({ statusCode: 200, body: dataBody({ backupCodes: ['ZXCV1-ASDF2'] }) });
  });

  cy.intercept('GET', '**/api/v1/auth/mfa/devices', req => {
    req.alias = 'listMfaDevices';
    req.reply({ statusCode: 200, body: dataBody(trustedDevices) });
  });

  // Idempotent by design (remembered-device.service.ts `updateMany where revokedAt: null`):
  // revoking an unknown/already-revoked device is a no-op that still answers 204.
  cy.intercept('DELETE', '**/api/v1/auth/mfa/devices/*', req => {
    req.alias = 'revokeMfaDevice';
    const id = apiPath(req.url).split('/').pop() ?? '';
    trustedDevices = trustedDevices.filter(device => device.id !== id);
    req.reply({ statusCode: 204, body: null });
  });

  cy.intercept('GET', '**/api/v1/operator/profile', req => {
    req.alias = 'getProfile';
    req.reply({ statusCode: 200, body: dataBody(profile) });
  });

  cy.intercept('PATCH', '**/api/v1/operator/profile', req => {
    req.alias = 'updateProfile';
    const body = record(req.body);
    profile = {
      displayName: text(body.displayName, profile.displayName),
      email: profile.email,
      phone: text(body.phone, profile.phone),
      jobTitle: text(body.jobTitle, profile.jobTitle),
    };
    req.reply({ statusCode: 200, body: dataBody(profile) });
  });

  cy.intercept('GET', '**/api/v1/operator/notification-preferences', req => {
    req.alias = 'getNotificationPreferences';
    req.reply({ statusCode: 200, body: dataBody(notificationPreferences) });
  });

  cy.intercept('PATCH', '**/api/v1/operator/notification-preferences', req => {
    req.alias = 'updateNotificationPreferences';
    notificationPreferences = {
      ...notificationPreferences,
      ...(record(req.body) as Partial<typeof notificationPreferences>),
    };
    req.reply({ statusCode: 200, body: dataBody(notificationPreferences) });
  });

  cy.intercept('GET', '**/api/v1/health', req => {
    req.alias = 'getHealth';
    req.reply({ statusCode: 200, body: dataBody({ status: 'ok', uptimeSeconds: 7542 }) });
  });

  cy.intercept('POST', '**/api/v1/dashboard/stream-token', req => {
    req.alias = 'streamToken';
    req.reply({ statusCode: 204, body: null });
  });

  cy.intercept('GET', '**/api/v1/dashboard/summary', req => {
    req.alias = 'dashboardSummary';
    req.reply({ statusCode: 200, body: dataBody(buildDashboardSummary(customers)) });
  });

  cy.intercept('GET', '**/api/v1/dashboard/kyc-distribution', req => {
    req.alias = 'dashboardKycDistribution';
    req.reply({
      statusCode: 200,
      body: dataBody({
        items: [
          { status: 'VERIFIED', count: 8, percent: 67 },
          { status: 'IN_REVIEW', count: 4, percent: 33 },
        ],
        total: customers.length,
        asOf: nowIso(),
      }),
    });
  });

  cy.intercept('GET', '**/api/v1/dashboard/latest-customer', req => {
    req.alias = 'dashboardLatestCustomer';
    req.reply({
      statusCode: 200,
      body: dataBody({
        customer: toDashboardCustomer(customers[0]),
        wallet: { currency: 'TRY', balanceMinor: wallet.balanceMinor },
      }),
    });
  });

  cy.intercept('GET', '**/api/v1/dashboard/recent-customers*', req => {
    req.alias = 'dashboardRecentCustomers';
    req.reply({
      statusCode: 200,
      body: dataBody(customers.slice(0, 3).map(toDashboardCustomer)),
    });
  });

  cy.intercept('GET', '**/api/v1/metrics/daily*', req => {
    req.alias = 'dailyMetrics';
    const metric = new URL(req.url).searchParams.get('metric') ?? 'transactions_count_daily';
    req.reply({
      statusCode: 200,
      body: dataBody({
        metric,
        items: [
          { date: '2026-07-06', value: '12' },
          { date: '2026-07-07', value: '18' },
          { date: '2026-07-08', value: '24' },
        ],
        asOf: nowIso(),
      }),
    });
  });

  cy.intercept('GET', '**/api/v1/catalog/currencies', req => {
    req.alias = 'listCurrencies';
    req.reply({
      statusCode: 200,
      body: dataBody({ items: [{ code: 'TRY', name: 'Turkish Lira', scale: 2 }] }),
    });
  });

  const customerGetHandler = (req: RouteRequest) => {
    const path = apiPath(req.url);
    if (path === '/customers') {
      req.alias = 'listCustomers';
      const reveal = revealEffective(req.url);
      const filtered = filterCustomers(customers, req.url);
      const { page, pageSize, rows } = paginateFromUrl(filtered, req.url, 10);
      req.reply({
        statusCode: 200,
        body: listBody(
          rows.map(c => toCustomerListItem(c, reveal)),
          pageMeta(page, pageSize, filtered.length),
        ),
      });
      return;
    }

    const segments = path.split('/').filter(Boolean);
    const customerId = decodeURIComponent(segments[1] ?? '');

    if (segments.length === 3 && segments[2] === 'wallet') {
      req.alias = 'getWallet';
      req.reply({ statusCode: 200, body: dataBody(wallet) });
      return;
    }

    if (segments.length === 3 && segments[2] === 'transactions') {
      req.alias = 'listTransactions';
      const filtered = filterTransactions(transactions, req.url);
      const { page, pageSize, rows } = paginateFromUrl(filtered, req.url, 10);
      req.reply({
        statusCode: 200,
        body: listBody(rows, pageMeta(page, pageSize, filtered.length)),
      });
      return;
    }

    if (segments.length === 3 && segments[2] === 'kyc-verifications') {
      req.alias = 'listKycVerifications';
      req.reply({ statusCode: 200, body: listBody([], pageMeta(1, 5, 0)) });
      return;
    }

    if (segments.length === 3 && segments[2] === 'risk-assessments') {
      req.alias = 'listRiskAssessments';
      req.reply({ statusCode: 200, body: listBody([], pageMeta(1, 5, 0)) });
      return;
    }

    if (segments.length === 3 && segments[2] === 'credential-preview') {
      req.alias = 'getCredentialPreview';
      req.reply({
        statusCode: 200,
        body: dataBody({
          '@context': ['https://www.w3.org/2018/credentials/v1'],
          type: ['VerifiableCredential', 'KycCredential'],
          issuer: 'did:web:fintech-dashboard.local',
          issuanceDate: '2026-07-08T09:00:00.000Z',
          credentialSubject: { id: customerId, kycVerified: true },
        }),
      });
      return;
    }

    const customer = customers.find(item => item.id === customerId);
    req.alias = 'getCustomer';
    if (!customer) {
      req.reply({
        statusCode: 404,
        body: errorEnvelope('Customers.NotFound', 'Customer not found.', CORR),
      });
      return;
    }
    req.reply({
      statusCode: 200,
      body: dataBody(toCustomerDetail(customer, revealEffective(req.url))),
    });
  };

  cy.intercept('GET', '**/api/v1/customers', customerGetHandler);
  cy.intercept('GET', '**/api/v1/customers?*', customerGetHandler);
  cy.intercept('GET', '**/api/v1/customers/**', customerGetHandler);

  cy.intercept('POST', '**/api/v1/customers', req => {
    req.alias = 'createCustomer';
    const body = record(req.body);
    const nationalId = String(body.nationalId ?? '10000000146');
    const created: BackendCustomer = {
      id: 'c-new',
      fullName: String(body.fullName ?? 'E2E Customer'),
      email: String(body.email ?? 'e2e.customer@example.com'),
      phone: text(body.phone, '+905551112233'),
      walletNumber: 'TRW-E2E-0001',
      nationalIdLast4: nationalId.slice(-4),
      kycStatus: 'NOT_STARTED',
      riskLevel: 'LOW',
      status: 'ACTIVE',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      dateOfBirth: text(body.dateOfBirth, '1990-01-01'),
      address: addressFrom(body.address),
      contractSigned: false,
      rowVersion: 1,
    };
    customers = [created, ...customers];
    // Real create() answers via getById() with DEFAULT masking — the echo is masked too.
    req.reply({ statusCode: 201, body: dataBody(toCustomerDetail(created, false)) });
  });

  cy.intercept('PUT', '**/api/v1/customers/*', req => {
    req.alias = 'updateCustomer';
    const id = decodeURIComponent(apiPath(req.url).split('/')[2] ?? '');
    const body = record(req.body);
    customers = customers.map(customer => {
      if (customer.id !== id) return customer;
      return {
        ...customer,
        fullName: text(body.fullName, customer.fullName),
        email: text(body.email, customer.email),
        phone: text(body.phone, customer.phone),
        dateOfBirth: text(body.dateOfBirth, customer.dateOfBirth),
        address: body.address ? addressFrom(body.address) : customer.address,
        kycStatus: customer.kycStatus,
        status: text(body.status, customer.status) as BackendCustomer['status'],
        updatedAt: nowIso(),
        rowVersion: customer.rowVersion + 1,
      };
    });
    const updated = customers.find(customer => customer.id === id);
    if (!updated) {
      req.reply({
        statusCode: 404,
        body: errorEnvelope('Customers.NotFound', 'Customer not found.', CORR),
      });
      return;
    }
    req.reply({ statusCode: 200, body: dataBody(toCustomerDetail(updated, false)) });
  });

  cy.intercept('DELETE', '**/api/v1/customers/*', req => {
    req.alias = 'deleteCustomer';
    const id = decodeURIComponent(apiPath(req.url).split('/')[2] ?? '');
    customers = customers.filter(customer => customer.id !== id);
    req.reply({ statusCode: 204, body: null });
  });

  // Optimistic concurrency exactly like wallets.service.ts:91-95 — ANY stale rowVersion 409s, and
  // keeps 409ing until the client re-fetches the fresh wallet. On a match the update applies and
  // the rowVersion advances.
  cy.intercept('PATCH', '**/api/v1/customers/*/wallet', req => {
    req.alias = 'updateWalletLimits';
    const body = record(req.body);
    if (Number(body.rowVersion) !== wallet.rowVersion) {
      req.reply({
        statusCode: 409,
        body: errorEnvelope(
          'Wallets.Conflict',
          'The wallet was modified by someone else. Reload and try again.',
          'e2e-corr-wallet',
        ),
      });
      return;
    }
    wallet = {
      ...wallet,
      dailyLimitMinor: String(Math.round(Number(body.dailyLimit ?? 0) * 100)),
      monthlyLimitMinor: String(Math.round(Number(body.monthlyLimit ?? 0) * 100)),
      rowVersion: wallet.rowVersion + 1,
    };
    req.reply({ statusCode: 200, body: dataBody(wallet) });
  });

  cy.intercept('POST', '**/api/v1/transactions', req => {
    req.alias = 'createTransaction';
    const body = record(req.body);
    const kind = String(body.kind ?? 'DEPOSIT') as BackendTransaction['kind'];
    const amountMinor = Number(body.amountMinor ?? 0);
    const signedMinor = kind === 'WITHDRAWAL' ? -Math.abs(amountMinor) : Math.abs(amountMinor);
    const created: BackendTransaction = {
      id: `tx-${transactions.length + 1}`,
      publicRef: `E2E-${transactions.length + 1}`,
      kind,
      status: 'POSTED',
      amountMinor: String(signedMinor),
      currency: String(body.currency ?? 'TRY'),
      description: text(body.description, 'E2E transaction'),
      occurredAt: nowIso(),
      postedAt: nowIso(),
    };
    transactions = [created, ...transactions];
    req.reply({
      statusCode: 201,
      body: dataBody({
        id: created.id,
        publicRef: created.publicRef,
        status: 'POSTED',
        amountMinor: String(Math.abs(amountMinor)),
        currency: created.currency,
        postedAt: created.postedAt,
      }),
    });
  });

  cy.intercept('GET', '**/api/v1/operator/notifications*', req => {
    // A spec may pre-register a conditional alias for this URL (e.g. per-filter aliases); only
    // claim the default alias when nobody else already did — never overwrite it.
    if (!req.alias) req.alias = 'listNotifications';
    const filtered = filterNotifications(notifications, req.url);
    const { page, pageSize, rows } = paginateFromUrl(filtered, req.url, 15);
    req.reply({
      statusCode: 200,
      body: listBody(rows, pageMeta(page, pageSize, filtered.length), {
        unreadCount: notifications.filter(item => !item.readAt).length,
      }),
    });
  });

  cy.intercept('POST', '**/api/v1/operator/notifications/read-all', req => {
    req.alias = 'markAllNotifications';
    const stamp = nowIso();
    notifications = notifications.map(item => ({ ...item, readAt: item.readAt ?? stamp }));
    req.reply({ statusCode: 200, body: dataBody({ unreadCount: 0 }) });
  });

  cy.intercept('POST', '**/api/v1/operator/notifications/*/read', req => {
    req.alias = 'markReadNotification';
    const id = decodeURIComponent(apiPath(req.url).split('/')[3] ?? '');
    const stamp = nowIso();
    notifications = notifications.map(item =>
      item.id === id ? { ...item, readAt: item.readAt ?? stamp } : item,
    );
    req.reply({
      statusCode: 200,
      body: dataBody({ unreadCount: notifications.filter(item => !item.readAt).length }),
    });
  });

  cy.intercept('GET', '**/api/v1/roles', req => {
    req.alias = 'listRoles';
    req.reply({
      statusCode: 200,
      body: dataBody({ items: [{ id: 'admin', name: 'Administrator', permissions }] }),
    });
  });

  cy.intercept('GET', '**/api/v1/permissions', req => {
    req.alias = 'listPermissions';
    req.reply({
      statusCode: 200,
      body: dataBody({ items: permissions.map(code => ({ id: code, code })) }),
    });
  });

  cy.intercept('GET', '**/api/v1/users', req => {
    req.alias = 'listUsers';
    const users = seedUserList();
    req.reply({
      statusCode: 200,
      body: listBody(users, pageMeta(1, 20, users.length)),
    });
  });

  return {
    bumpWalletVersion(): void {
      // Enqueued so the bump lands at its position in the spec's command timeline (a bare closure
      // mutation would run at spec-body time, BEFORE the app ever loaded the original wallet).
      cy.then(() => {
        wallet = {
          ...wallet,
          // Another operator nudged the limits too, so the re-fetched form visibly re-seeds.
          dailyLimitMinor: '550000',
          monthlyLimitMinor: '1600000',
          rowVersion: wallet.rowVersion + 1,
        };
      });
    },
  };
}

function installNoopEventSource(win: Cypress.AUTWindow): void {
  const EventTargetCtor = win.EventTarget;
  class NoopEventSource extends EventTargetCtor {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly url: string;
    readonly withCredentials: boolean;
    readyState = NoopEventSource.OPEN;
    onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
    onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = String(url);
      this.withCredentials = !!init?.withCredentials;
    }

    close(): void {
      this.readyState = NoopEventSource.CLOSED;
    }
  }

  win.EventSource = NoopEventSource as unknown as typeof EventSource;
}

function apiPath(url: string): string {
  const pathname = new URL(url).pathname;
  const marker = '/api/v1';
  if (!pathname.startsWith(marker)) return pathname;
  return pathname.slice(marker.length) || '/';
}

function paginateFromUrl<T>(
  items: readonly T[],
  url: string,
  defaultPageSize: number,
): { page: number; pageSize: number; rows: T[] } {
  const params = new URL(url).searchParams;
  const page = positiveInt(params.get('page[number]'), 1);
  const pageSize = positiveInt(params.get('page[size]'), defaultPageSize);
  const start = (page - 1) * pageSize;
  return { page, pageSize, rows: items.slice(start, start + pageSize) };
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function filterCustomers(customers: readonly BackendCustomer[], url: string): BackendCustomer[] {
  const params = new URL(url).searchParams;
  const q = (params.get('filter[q]') ?? '').trim().toLowerCase();
  const kyc = params.get('filter[kycStatus]');
  const active = params.get('filter[active]');
  return customers.filter(customer => {
    const matchesSearch =
      !q ||
      customer.fullName.toLowerCase().includes(q) ||
      customer.email.toLowerCase().includes(q) ||
      (customer.walletNumber ?? '').toLowerCase().includes(q);
    const matchesKyc = !kyc || customer.kycStatus === kyc;
    const matchesActive =
      active == null ||
      active === '' ||
      (active === 'true' ? customer.status === 'ACTIVE' : customer.status !== 'ACTIVE');
    return matchesSearch && matchesKyc && matchesActive;
  });
}

function filterTransactions(
  transactions: readonly BackendTransaction[],
  url: string,
): BackendTransaction[] {
  const params = new URL(url).searchParams;
  const kind = params.get('filter[kind]');
  const status = params.get('filter[status]');
  const currency = params.get('filter[currency]');
  const from = toTime(params.get('filter[occurredFrom]'));
  const to = toTime(params.get('filter[occurredTo]'));
  return transactions.filter(tx => {
    const occurredAt = new Date(tx.occurredAt).getTime();
    return (
      (!kind || tx.kind === kind) &&
      (!status || tx.status === status) &&
      (!currency || tx.currency === currency) &&
      (from === null || occurredAt >= from) &&
      (to === null || occurredAt <= to)
    );
  });
}

function filterNotifications(
  notifications: readonly AppNotification[],
  url: string,
): AppNotification[] {
  const params = new URL(url).searchParams;
  const type = params.get('filter[type]');
  const severity = params.get('filter[severity]');
  const read = params.get('filter[read]');
  return notifications.filter(item => {
    const matchesRead =
      read == null || read === '' || (read === 'true' ? !!item.readAt : !item.readAt);
    return (
      (!type || item.type === type) && (!severity || item.severity === severity) && matchesRead
    );
  });
}

function toTime(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function addressFrom(value: unknown): BackendCustomer['address'] {
  const body = record(value);
  return {
    country: text(body.country, 'Turkiye'),
    city: text(body.city, 'Istanbul'),
    postalCode: text(body.postalCode, '34000'),
    line1: text(body.line1, 'Maslak Mahallesi Buyukdere Caddesi 1'),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function text(value: unknown, fallback: string | null): string {
  if (typeof value !== 'string') return fallback ?? '';
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}
