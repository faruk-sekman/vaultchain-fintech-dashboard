/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { appShell, visitAuthenticated } from '../support/screens/app.screen';

describe('Enterprise responsive smoke', () => {
  it('renders the authenticated desktop shell without horizontal overflow', () => {
    cy.viewport(1440, 900);
    visitAuthenticated('/dashboard');

    appShell.assertReady();
    cy.byTestId('user-menu-trigger').should('be.visible');
    appShell.assertNoHorizontalOverflow();
  });

  it('renders the mobile shell and opens navigation without horizontal overflow', () => {
    cy.viewport(390, 844);
    visitAuthenticated('/customers');
    cy.wait('@listCustomers');

    appShell.openMobileNavigation();
    cy.byTestId('main-content').should('be.visible');
    appShell.assertNoHorizontalOverflow();
  });
});
