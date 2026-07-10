/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { READ_ONLY_PERMISSIONS, visitEnterprise } from '../support/enterprise-api';
import { visitAuthenticated } from '../support/screens/app.screen';
import { customerForm, customersList } from '../support/screens/customers.screen';

describe('Enterprise customer flows', () => {
  it('filters, paginates, and opens customer detail from the list contract', () => {
    customersList.visit();

    // Default read surface is MASKED: the wire carries mask.ts shapes, never raw PII.
    cy.byTestId('customers-table').should('contain.text', 'Aylin K***');
    cy.byTestId('customers-table').should('contain.text', 'a***@e***.com');
    cy.byTestId('customers-table').should('not.contain.text', 'Aylin Kaya');

    // The admin persona reveals explicitly: the FE re-fetches with `reveal=true` on the wire.
    customersList.togglePiiReveal();
    cy.wait('@listCustomers').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('reveal')).to.eq('true');
    });
    cy.byTestId('customers-table').should('contain.text', 'Aylin Kaya');

    customersList.search('Bora');
    cy.wait('@listCustomers').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('filter[q]')).to.eq('Bora');
      expect(params.get('page[number]')).to.eq('1');
    });
    cy.byTestId('customers-table').should('contain.text', 'Bora Demir');

    customersList.clearSearch();
    cy.wait('@listCustomers');
    customersList.filterKycByIndex(4);
    cy.wait('@listCustomers').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('filter[kycStatus]')).to.eq('VERIFIED');
    });
    // Row-level proof of the filter: exactly the 5 VERIFIED seed rows render, every row carries
    // the Verified badge, and a non-verified seed name is gone from the DOM.
    cy.byTestId('customers-table').find('tbody tr').should('have.length', 5);
    cy.byTestId('customers-table')
      .find('tbody tr')
      .each($row => {
        expect($row.text()).to.contain('Verified');
      });
    cy.byTestId('customers-table').should('not.contain.text', 'Bora Demir');

    customersList.filterKycByIndex(0);
    cy.wait('@listCustomers');
    customersList.goToPage('2');
    cy.wait('@listCustomers').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('page[number]')).to.eq('2');
    });
    cy.url().should('include', 'page=2');
    // Page 2 holds DIFFERENT rows than page 1: the 11th/12th seed customers, and none of page 1.
    cy.byTestId('customers-table').find('tbody tr').should('have.length', 2);
    cy.byTestId('customers-table').should('contain.text', 'Leyla Er');
    cy.byTestId('customers-table').should('contain.text', 'Mert Aksoy');
    cy.byTestId('customers-table').should('not.contain.text', 'Aylin Kaya');

    // A fresh detail navigation resets to the DEFAULT masked read (reveal is never persisted).
    customersList.openDetail();
    cy.byTestId('customer-detail-summary').should('contain.text', 'Aylin K***');
    cy.byTestId('transaction-table').should('contain.text', 'Initial salary credit');
  });

  it('serves masked PII to a persona without customers.pii.reveal (masked-path)', () => {
    visitAuthenticated('/customers', { permissions: READ_ONLY_PERMISSIONS });
    cy.wait('@listCustomers').then(interception => {
      // The FE does not even ASK for raw data without the permission (request-only reveal intent).
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('reveal')).to.eq(null);
    });
    cy.byTestId('customers-table').should('contain.text', 'Aylin K***');
    cy.byTestId('customers-table').should('contain.text', 'a***@e***.com');
    cy.byTestId('customers-table').should('not.contain.text', 'Aylin Kaya');
    // And the reveal affordance itself is absent for the persona.
    cy.byTestId('customers-pii-toggle').should('not.exist');
  });

  it('creates, edits, and deletes a customer through the real forms', () => {
    visitAuthenticated('/customers/new');

    customerForm.fillCreateForm();
    customerForm.save();

    cy.wait('@createCustomer').then(interception => {
      expect(interception.request.body).to.include({
        fullName: 'Elif Yildiz',
        email: 'e2e.customer@example.com',
        nationalId: '10000000146',
      });
    });
    cy.url().should('include', '/customers/c-new');
    // The post-create read is the DEFAULT masked detail (create echoes like the real
    // create → getById(masked) path). Consume this @getCustomer so later waits stay aligned.
    cy.wait('@getCustomer').then(interception => {
      expect(new URL(interception.request.url).searchParams.get('reveal')).to.eq(null);
    });
    cy.byTestId('customer-detail-summary').should('contain.text', 'Elif Y***');

    visitEnterprise('/customers/c-1/edit', { sessionHint: true });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    // A12: the Administrator edit form loads UNMASKED — the reveal intent is explicit on the wire.
    cy.wait('@getCustomer').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('reveal')).to.eq('true');
    });
    customerForm.updateName('Aylin Kaya Updated');
    customerForm.save();

    cy.wait('@updateCustomer').then(interception => {
      expect(interception.request.body).to.include({
        fullName: 'Aylin Kaya Updated',
        rowVersion: 7,
      });
    });
    cy.url().should('include', '/customers/c-1');

    visitEnterprise('/customers', { sessionHint: true });
    cy.wait('@refreshSession');
    cy.wait('@authMe');
    cy.wait('@listCustomers');
    // Fresh list = masked again; the updated customer appears (and is deleted) in its masked shape.
    customersList.deleteCustomerByName('Aylin K*** U***');

    cy.wait('@deleteCustomer').then(interception => {
      expect(interception.request.url).to.include('/customers/c-1');
    });
    cy.contains('[data-testid="customers-table"]', 'Aylin K*** U***').should('not.exist');
  });
});
