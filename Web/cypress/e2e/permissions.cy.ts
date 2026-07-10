/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import {
  READ_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  stubEnterpriseApi,
  visitEnterprise,
} from '../support/enterprise-api';

function visitCustomersAs(permissions: string[]): void {
  stubEnterpriseApi({ permissions });
  visitEnterprise('/customers', { sessionHint: true });
  cy.wait('@refreshSession');
  cy.wait('@authMe');
  cy.wait('@listCustomers');
}

/** The permission-gated customer-list controls, asserted SYMMETRICALLY per persona. */
function expectListControls(controls: { create: boolean; del: boolean; reveal: boolean }): void {
  cy.byTestId('customers-create').should(controls.create ? 'exist' : 'not.exist');
  cy.byTestId('customers-row-delete').should(controls.del ? 'exist' : 'not.exist');
  cy.byTestId('customers-pii-toggle').should(controls.reveal ? 'exist' : 'not.exist');
  // The plain "open detail" row action is read-scope: every persona keeps it.
  cy.byTestId('customers-row-open').should('have.length.greaterThan', 0);
}

describe('Enterprise role and permission visibility', () => {
  it('shows privileged customer-list controls to the full persona and hides them from read-only — symmetrically', () => {
    // FULL persona: the gated controls exist…
    visitCustomersAs(ROLE_PERMISSIONS.administrator);
    expectListControls({ create: true, del: true, reveal: true });

    // …READ-ONLY persona: the same controls are absent (not merely disabled).
    visitCustomersAs(READ_ONLY_PERMISSIONS);
    expectListControls({ create: false, del: false, reveal: false });

    visitEnterprise('/customers/c-1', { sessionHint: true });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.wait('@getCustomer');
    cy.wait('@getWallet');

    // Detail-page gates (icon-scoped inside the stable actions container: the edit/delete buttons
    // carry no own testid — the detail template is outside this remediation's surface).
    cy.byTestId('customer-detail-actions').find('.ri-pencil-line').should('not.exist');
    cy.byTestId('customer-detail-actions').find('.ri-delete-bin-6-line').should('not.exist');
    cy.byTestId('transaction-create-panel').should('not.exist');
    cy.byTestId('wallet-limit-editor').find('.enterprise-form-actions').should('not.exist');

    visitEnterprise('/customers/new', { sessionHint: true });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.url().should('include', '/customers');
    cy.url().should('not.include', '/customers/new');
  });

  it('applies the administrator / operator / auditor matrices from the seeded RBAC roles', () => {
    // Mirrors Api/scripts/seed-dev.ts ROLES: administrator = all three controls; operator
    // ("Compliance Officer") = customers.manage but NO delete and NO PII reveal; auditor
    // ("Viewer") = read-only.
    visitCustomersAs(ROLE_PERMISSIONS.administrator);
    expectListControls({ create: true, del: true, reveal: true });

    visitCustomersAs(ROLE_PERMISSIONS.operator);
    expectListControls({ create: true, del: false, reveal: false });

    visitCustomersAs(ROLE_PERMISSIONS.auditor);
    expectListControls({ create: false, del: false, reveal: false });
  });
});
