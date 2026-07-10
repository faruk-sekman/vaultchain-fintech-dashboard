/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { visitAuthenticated } from './app.screen';

export class CustomersListScreen {
  visit(): void {
    visitAuthenticated('/customers');
    cy.wait('@listCustomers');
  }

  search(term: string): void {
    cy.byTestId('customers-filter-search').find('input').clear().type(term);
  }

  clearSearch(): void {
    cy.byTestId('customers-filter-search').find('input').clear();
  }

  filterKycByIndex(index: number): void {
    cy.byTestId('customers-filter-kyc').find('select').select(index);
  }

  goToPage(label: string): void {
    cy.contains('button.ui-pagination__page', label).click();
  }

  openDetail(path = '/customers/c-1'): void {
    visitAuthenticated(path);
    cy.wait('@getCustomer');
    cy.wait('@getWallet');
  }

  /** Admin-only PII reveal toggle: re-loads the list with `reveal=true`. */
  togglePiiReveal(): void {
    cy.byTestId('customers-pii-toggle').find('button').click();
  }

  deleteCustomerByName(name: string): void {
    cy.contains('tr', name).within(() => {
      cy.byTestId('customers-row-delete').find('button').click();
    });
    cy.get('.confirm-card .ui-button--danger').click();
  }
}

// `ui-form` control ids carry a positional index (`ui-form-<i>-<field>`); anchor on the stable
// prefix + field-name suffix so inserting/reordering a field never silently rewires a selector.
const formField = (name: string): string => `[id^="ui-form-"][id$="-${name}"]`;

export class CustomerFormScreen {
  fillCreateForm(): void {
    cy.get(formField('name')).type('Elif Yildiz');
    cy.get(formField('email')).type('e2e.customer@example.com');
    cy.get(formField('phone')).type('+905551112233');
    cy.get(formField('dateOfBirth')).type('1992-02-02');
    cy.get(formField('nationalId')).type('10000000146');
    cy.get(formField('address-country')).type('Turkiye');
    cy.get(formField('address-city')).type('Istanbul');
    cy.get(formField('address-postalCode')).type('34000');
    cy.get(formField('address-line1')).type('Maslak Mahallesi Buyukdere Caddesi 1');
  }

  save(): void {
    cy.get('.form-actions__save button').click();
  }

  updateName(name: string): void {
    cy.get(formField('name')).clear().type(name);
  }
}

export const customersList = new CustomersListScreen();
export const customerForm = new CustomerFormScreen();
