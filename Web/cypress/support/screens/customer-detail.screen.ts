/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import {
  EnterpriseApiController,
  FULL_PERMISSIONS,
  stubEnterpriseApi,
  visitEnterprise,
} from '../enterprise-api';

export function visitCustomerDetail(): EnterpriseApiController {
  const api = stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
  visitEnterprise('/customers/c-1', { sessionHint: true });
  cy.wait('@refreshSession');
  cy.wait('@authMe');
  cy.wait('@getCustomer');
  cy.wait('@getWallet');
  return api;
}

// `ui-form` control ids carry a positional index (`<formId>-<i>-<field>`); anchor on the stable
// prefix + field-name suffix so inserting/reordering a field never silently rewires a selector.
const walletField = (name: string): string =>
  `[id^="customer-detail-wallet-limits-form-"][id$="-${name}"]`;
const txCreateField = (name: string): string =>
  `[id^="customer-detail-transaction-create-form-"][id$="-${name}"]`;
const txFilterField = (name: string): string =>
  `select[id^="customer-detail-transaction-filter-form-"][id$="-${name}"]`;

export class CustomerDetailScreen {
  fillWalletLimits(dailyLimit: string, monthlyLimit: string): void {
    cy.byTestId('wallet-limit-editor').find(walletField('dailyLimit')).clear().type(dailyLimit);
    cy.byTestId('wallet-limit-editor').find(walletField('monthlyLimit')).clear().type(monthlyLimit);
  }

  expectWalletLimitValues(dailyLimit: string, monthlyLimit: string): void {
    cy.byTestId('wallet-limit-editor')
      .find(walletField('dailyLimit'))
      .should('have.value', dailyLimit);
    cy.byTestId('wallet-limit-editor')
      .find(walletField('monthlyLimit'))
      .should('have.value', monthlyLimit);
  }

  saveWalletLimits(): void {
    cy.byTestId('wallet-limit-editor').find('.enterprise-form-actions button').last().click();
  }

  assertWalletMeterVisible(): void {
    cy.byTestId('wallet-limit-meter').should('exist');
  }

  createDeposit(amount: string, description: string): void {
    cy.byTestId('transaction-create-panel').find(txCreateField('amount')).clear().type(amount);
    cy.byTestId('transaction-create-panel').find(txCreateField('description')).type(description);
    cy.byTestId('transaction-create-submit').find('button').click();
  }

  filterStatusByIndex(index: number): void {
    cy.byTestId('transaction-filter-panel').find(txFilterField('status')).select(index);
  }

  filterKindByIndex(index: number): void {
    cy.byTestId('transaction-filter-panel').find(txFilterField('kind')).select(index);
  }

  assertTransactionVisible(description: string): void {
    cy.byTestId('transaction-table').should('contain.text', description);
  }

  assertTransactionHidden(description: string): void {
    cy.byTestId('transaction-table').should('not.contain.text', description);
  }
}

export const customerDetail = new CustomerDetailScreen();
