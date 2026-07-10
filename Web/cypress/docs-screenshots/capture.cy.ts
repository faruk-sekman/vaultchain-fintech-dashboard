/*
 * Documentation screenshot lane.
 *
 * The real Angular UI is rendered at 1600x1511 against the same contract-checked deterministic
 * fixtures as the offline E2E suite. No production account, database, external RPC, secret, QR code,
 * or usable one-time credential is touched. Run with:
 *
 *   npm --prefix Web run e2e:docs-shots
 */
import { FULL_PERMISSIONS, stubEnterpriseApi, visitEnterprise } from '../support/enterprise-api';

type Theme = 'light' | 'dark';
type Language = 'en' | 'tr';

interface VisitOptions {
  language?: Language;
  mfaEnabled?: boolean;
  theme?: Theme;
}

const META = { correlationId: 'docs-capture' };

function dataBody<T>(data: T): { data: T; meta: typeof META } {
  return { data, meta: META };
}

function visitAuthenticated(path: string, options: VisitOptions = {}): void {
  stubEnterpriseApi({
    permissions: FULL_PERMISSIONS,
    mfaEnabled: options.mfaEnabled ?? false,
  });
  stubAdminRecoveryRoutes();
  visitEnterprise(path, {
    language: options.language ?? 'en',
    sessionHint: true,
    sidebarCollapsed: false,
    theme: options.theme ?? 'light',
  });
  cy.wait('@refreshSession');
  cy.wait('@authMe');
  cy.byTestId('main-content', { timeout: 12000 }).should('be.visible');
}

function stabilizeFrame(): void {
  cy.document().then(doc => {
    const style = doc.createElement('style');
    style.setAttribute('data-docs-capture', '');
    style.textContent = `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
    `;
    doc.head.appendChild(style);
    return doc.fonts.ready;
  });
}

function shoot(name: string, settleMs = 350, capture: 'viewport' | 'fullPage' = 'fullPage'): void {
  stabilizeFrame();
  cy.wait(settleMs);
  cy.screenshot(name, { capture, overwrite: true });
}

function stubPasswordResetRoutes(): void {
  cy.intercept('POST', '**/api/v1/auth/password/reset/initiate', {
    statusCode: 202,
    body: dataBody({ status: 'reset_initiated' }),
  }).as('resetInitiate');
  cy.intercept('POST', '**/api/v1/auth/password/reset/verify-code', {
    statusCode: 200,
    body: dataBody({ status: 'code_verified' }),
  }).as('resetVerifyCode');
  cy.intercept('POST', '**/api/v1/auth/password/reset/verify', {
    statusCode: 200,
    body: dataBody({ status: 'reset_complete' }),
  }).as('resetVerify');
}

function stubAdminRecoveryRoutes(): void {
  const request = {
    id: 'req-docs-1',
    account: { displayName: 'Mert Demir', emailMasked: 'm***@d***.local' },
    status: 'PENDING',
    createdAt: '2026-07-09T18:20:00.000Z',
    expiresAt: '2026-07-09T18:50:00.000Z',
    decidedAt: null,
    decidedByName: null,
    completedAt: null,
  };

  cy.intercept('GET', '**/api/v1/auth/password/reset-requests', {
    statusCode: 200,
    body: dataBody([request]),
  }).as('listResetRequests');
  cy.intercept('GET', '**/api/v1/auth/password/reset-requests/*', {
    statusCode: 200,
    body: dataBody({
      ...request,
      ipPrefix: '10.24.8.0/24',
      deviceSummary: 'Chrome on macOS',
      userAgent: null,
    }),
  }).as('getResetRequest');
  cy.intercept('POST', '**/api/v1/auth/password/admin-reset', {
    statusCode: 204,
    body: null,
  }).as('adminPasswordReset');
  cy.intercept('POST', '**/api/v1/auth/mfa/admin-reset', {
    statusCode: 204,
    body: null,
  }).as('adminMfaReset');
}

function stubWeb3Routes(flagged: boolean): void {
  cy.intercept('POST', 'https://ethereum-rpc.publicnode.com*', req => {
    const method = String((req.body as { method?: unknown })?.method ?? '');
    const results: Record<string, string> = {
      eth_getBalance: '0x1158e460913d0000',
      eth_getTransactionCount: '0x2a',
      eth_getCode: '0x',
      eth_chainId: '0x1',
      eth_blockNumber: '0x134d8e0',
      eth_gasPrice: '0x5d21dba00',
    };
    req.reply({ statusCode: 200, body: { jsonrpc: '2.0', id: 1, result: results[method] } });
  }).as('ethereumRpc');

  const signals = [
    { key: 'mixerExposure', hit: flagged, severity: 'high' },
    { key: 'highVelocity', hit: flagged, severity: 'medium' },
    { key: 'suspiciousCounterparty', hit: false, severity: 'medium' },
    { key: 'sanctionsHit', hit: false, severity: 'high' },
  ];
  cy.intercept('POST', '**/api/v1/customers/*/risk-screenings', {
    statusCode: 200,
    body: dataBody({
      address: '0x1111111111111111111111111111111111111111',
      decision: flagged ? 'REVIEW' : 'ALLOW',
      isSimulated: true,
      providerName: 'rule-based-risk-engine',
      signals,
    }),
  }).as('riskScreening');
}

describe('documentation screenshots', { defaultCommandTimeout: 15000 }, () => {
  it('captures sign-in, dark mode, MFA, and every self-service reset step', () => {
    visitEnterprise('/login', { language: 'en', theme: 'light' });
    cy.byTestId('login-page').should('be.visible');
    shoot('login', 1800);

    cy.byTestId('login-demo-card').first().click();
    cy.byTestId('login-email').should('not.have.value', '');
    shoot('login-demo-roles', 800, 'fullPage');

    visitEnterprise('/login', { language: 'en', theme: 'dark' });
    cy.get('html').should('have.attr', 'data-theme', 'dark');
    shoot('login-dark', 1800);

    stubEnterpriseApi({
      permissions: FULL_PERMISSIONS,
      loginRequiresMfa: true,
      mfaEnabled: true,
    });
    visitEnterprise('/login', { language: 'en', theme: 'light' });
    cy.byTestId('login-email').clear().type('admin@ftd.local');
    cy.byTestId('login-password').clear().type('Passw0rd!', { log: false });
    cy.byTestId('login-submit').click();
    cy.wait('@login');
    cy.byTestId('mfa-verify-page').should('be.visible');
    shoot('mfa-verify', 800);

    stubPasswordResetRoutes();
    visitEnterprise('/forgot-password', { language: 'en', theme: 'light' });
    cy.get('#forgot-email').should('be.visible');
    shoot('forgot-password-email', 1800);

    cy.get('#forgot-email').type('admin@ftd.local');
    cy.get('form.forgot__pane button[type="submit"]').click();
    cy.wait('@resetInitiate');
    cy.get('app-otp-input').should('be.visible');
    shoot('forgot-password-otp', 800);

    cy.get('app-otp-input .otp__box').each(($input, index) => {
      cy.wrap($input).type(String(index + 1));
    });
    cy.get('form.forgot__pane button[type="submit"]').click();
    cy.wait('@resetVerifyCode');
    cy.get('#forgot-password').should('be.visible');
    shoot('forgot-password-reset', 800, 'fullPage');
  });

  it('captures dashboard light, dark, Turkish, and loading states', () => {
    visitAuthenticated('/dashboard');
    cy.wait('@dashboardSummary');
    shoot('dashboard-light');

    visitAuthenticated('/dashboard', { theme: 'dark' });
    cy.wait('@dashboardSummary');
    cy.get('html').should('have.attr', 'data-theme', 'dark');
    shoot('dashboard-dark');

    visitAuthenticated('/dashboard', { language: 'tr' });
    cy.wait('@dashboardSummary');
    shoot('dashboard-tr');

    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    cy.intercept('GET', '**/api/v1/dashboard/summary', {
      delay: 4000,
      statusCode: 200,
      body: dataBody({}),
    });
    cy.intercept('GET', '**/api/v1/dashboard/kyc-distribution', {
      delay: 4000,
      statusCode: 200,
      body: dataBody({ items: [], total: 0, asOf: '2026-07-09T18:20:00.000Z' }),
    });
    visitEnterprise('/dashboard', {
      language: 'en',
      sessionHint: true,
      sidebarCollapsed: false,
      theme: 'light',
    });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.byTestId('main-content').should('be.visible');
    shoot('dashboard-skeleton', 80);
  });

  it('captures every customer route and the destructive confirmation state', () => {
    visitAuthenticated('/customers');
    cy.wait('@listCustomers');
    cy.byTestId('customers-table').should('be.visible');
    shoot('customers-list');

    cy.byTestId('customers-row-delete').first().find('button').click();
    cy.get('.confirm-card').should('be.visible');
    shoot('customer-delete-modal');

    visitAuthenticated('/customers/new');
    cy.get('.customer-form').should('be.visible');
    shoot('customer-create');

    visitAuthenticated('/customers/c-1');
    cy.wait('@getCustomer');
    cy.wait('@getWallet');
    cy.byTestId('customer-detail-summary').should('be.visible');
    shoot('customer-detail');

    visitAuthenticated('/customers/c-1/edit');
    cy.wait('@getCustomer');
    cy.get('[id^="ui-form-"][id$="-name"]').clear();
    cy.get('.form-actions__save button').click();
    cy.get('[role="alert"]').should('be.visible');
    shoot('customer-edit-validation');
  });

  it('captures read-only Web3 clear and flagged states without external network access', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    stubWeb3Routes(false);
    visitEnterprise('/customers/c-1/web3-risk', {
      language: 'en',
      sessionHint: true,
      sidebarCollapsed: false,
      theme: 'light',
    });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.wait('@getCustomer');
    cy.get('.web3-screen app-ui-button button').click();
    cy.wait('@riskScreening');
    cy.get('.web3-facts').should('be.visible');
    shoot('web3-risk');

    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    stubWeb3Routes(true);
    visitEnterprise('/customers/c-1/web3-risk', {
      language: 'en',
      sessionHint: true,
      sidebarCollapsed: false,
      theme: 'light',
    });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.wait('@getCustomer');
    cy.get('.web3-screen app-ui-button button').click();
    cy.wait('@riskScreening');
    cy.get('app-ui-alert.web3-flagged').scrollIntoView().should('be.visible');
    shoot('web3-risk-flagged');
  });

  it('captures analytics and notification operations', () => {
    visitAuthenticated('/analytics');
    cy.get('.page-shell.analytics').should('be.visible');
    shoot('analytics');

    visitAuthenticated('/notifications');
    cy.get('[data-testid^="notification-row-"]').should('have.length.greaterThan', 0);
    shoot('notifications');
  });

  it('captures every settings panel plus both recovery tools', () => {
    visitAuthenticated('/settings?section=profile');
    cy.wait('@getProfile');
    cy.byTestId('settings-panel-profile').should('be.visible');
    shoot('settings');

    visitAuthenticated('/settings?section=security', { mfaEnabled: true });
    cy.wait('@listMfaDevices');
    cy.byTestId('settings-panel-security').should('be.visible');
    shoot('settings-security');

    visitAuthenticated('/settings?section=appearance');
    cy.byTestId('settings-panel-appearance').should('be.visible');
    shoot('settings-appearance');

    visitAuthenticated('/settings?section=appearance', { theme: 'dark' });
    cy.byTestId('settings-panel-appearance').should('be.visible');
    cy.get('html').should('have.attr', 'data-theme', 'dark');
    shoot('settings-appearance-dark');

    visitAuthenticated('/settings?section=language');
    cy.byTestId('settings-panel-language').should('be.visible');
    shoot('settings-language');

    visitAuthenticated('/settings?section=notifications');
    cy.wait('@getNotificationPreferences');
    cy.byTestId('settings-panel-notifications').should('be.visible');
    shoot('settings-notifications');

    visitAuthenticated('/settings?section=access');
    cy.wait('@getHealth');
    cy.byTestId('settings-panel-access').should('be.visible');
    shoot('settings-access');

    visitAuthenticated('/settings/mfa');
    cy.byTestId('mfa-setup-password-input').should('be.visible');
    shoot('mfa-setup');

    visitAuthenticated('/admin-password-reset');
    cy.wait('@listUsers');
    cy.wait('@listResetRequests');
    cy.get('#admin-pw-reset-picker').should('be.visible');
    shoot('admin-password-reset');

    visitAuthenticated('/settings/admin-mfa-reset');
    cy.get('#admin-mfa-reset-user-id').should('be.visible');
    shoot('admin-mfa-reset');
  });
});
