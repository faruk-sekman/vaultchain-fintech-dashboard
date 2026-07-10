/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { expectAliasContract } from '../support/api-contracts';
import { FULL_PERMISSIONS, stubEnterpriseApi, visitEnterprise } from '../support/enterprise-api';
import { loginScreen } from '../support/screens/auth.screen';

describe('Enterprise API contract smoke', () => {
  it('validates auth, customer, wallet, and transaction envelopes', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });

    visitEnterprise('/login');
    loginScreen.login();
    expectAliasContract('@login', 'auth.session');

    visitEnterprise('/customers', { sessionHint: true });
    expectAliasContract('@refreshSession', 'auth.refresh');
    expectAliasContract('@authMe', 'auth.principal');
    expectAliasContract('@listCustomers', 'customer.page');

    visitEnterprise('/customers/c-1', { sessionHint: true });
    expectAliasContract('@refreshSession', 'auth.refresh');
    expectAliasContract('@authMe', 'auth.principal');
    expectAliasContract('@getCustomer', 'customer.detail');
    expectAliasContract('@getWallet', 'wallet.detail');
    expectAliasContract('@listTransactions', 'transaction.page');

    cy.byTestId('transaction-create-panel').should('be.visible');
    // Suffix-stable ui-form selectors: the numeric segment is a positional index, never pin it.
    cy.get('[id^="customer-detail-transaction-create-form-"][id$="-amount"]').clear().type('42.5');
    cy.get('[id^="customer-detail-transaction-create-form-"][id$="-description"]').type(
      'Contract smoke credit',
    );
    cy.byTestId('transaction-create-submit').find('button').click();
    expectAliasContract('@createTransaction', 'transaction.create');
    expectAliasContract('@listTransactions', 'transaction.page');
  });

  it('validates notification and operator settings envelopes', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });

    visitEnterprise('/settings', { sessionHint: true });
    expectAliasContract('@refreshSession', 'auth.refresh');
    expectAliasContract('@authMe', 'auth.principal');
    expectAliasContract('@getProfile', 'operator.profile');
    expectAliasContract('@getNotificationPreferences', 'operator.notificationPreferences');

    visitEnterprise('/notifications', { sessionHint: true });
    expectAliasContract('@refreshSession', 'auth.refresh');
    expectAliasContract('@authMe', 'auth.principal');
    expectAliasContract('@listNotifications', 'notification.page');
  });
});
