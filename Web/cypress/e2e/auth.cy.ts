/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * E2E: the operator login journey. All backend calls are stubbed, so
 * this runs without a live API. Notes specific to this app:
 *  - the access token is in memory only, so success is asserted via landing on /dashboard
 *    and verifying no token lands in web storage;
 *  - logout is driven from the header user-menu's onLogout() and is unit-covered in
 *    header.component.spec.ts; here we cover the guard's redirect of an unauthenticated deep-link.
 */
import { AUTH_RESPONSE } from '../support/commands';

describe('Operator auth flow', () => {
  it('logs in through the form and lands on the dashboard', () => {
    cy.login();

    // The credentials travel EXACTLY as typed — nothing extra rides on the login payload.
    cy.get('@loginReq')
      .its('request.body')
      .should('deep.equal', { email: 'admin@ftd.io', password: 'Passw0rd!' });

    cy.url().should('include', '/dashboard');
    // Copy-independent landing proof (nav labels are i18n/seed-driven; testids are the contract).
    cy.byTestId('app-shell').should('be.visible');
    cy.byTestId('main-content').should('be.visible');
    // In-memory token: no token value may be persisted in browser storage.
    cy.window().then(win => {
      expect(win.localStorage.getItem('ftd_access_token')).to.be.null;
      expect(win.sessionStorage.getItem('ftd_access_token')).to.be.null;
      expect(win.localStorage.getItem('ftd_refresh_token')).to.be.null;
    });
  });

  it('shows an inline error and stays on /login for invalid credentials', () => {
    cy.intercept('POST', '**/api/v1/auth/login', {
      statusCode: 401,
      body: { error: { code: 'Auth.InvalidCredentials', message: 'Invalid email or password.' } },
    }).as('badLogin');

    cy.visit('/login');
    cy.byTestId('login-email').type('admin@ftd.io');
    cy.byTestId('login-password').type('wrong-password', { log: false });
    cy.byTestId('login-submit').click();

    cy.wait('@badLogin');
    cy.byTestId('login-alert').should('be.visible');
    cy.url().should('include', '/login');
    // No session was established.
    cy.window().its('localStorage').invoke('getItem', 'ftd_session').should('not.eq', '1');
  });

  it('redirects an unauthenticated deep-link to /login (route guard)', () => {
    cy.intercept('POST', '**/api/v1/auth/refresh', { statusCode: 401, body: {} });

    cy.visit('/dashboard');

    cy.url().should('include', '/login');
  });

  it('fills credentials from a demo-account shortcut', () => {
    cy.intercept('POST', '**/api/v1/auth/login', { statusCode: 200, body: AUTH_RESPONSE }).as(
      'loginReq',
    );
    cy.intercept('GET', '**/api/v1/**', {
      statusCode: 200,
      body: { data: [], meta: { total: 0 } },
    });

    cy.visit('/login');
    cy.byTestId('login-demo-card').first().click();
    // The shortcut populates the email field (the exact value is i18n/seed-driven; assert non-empty).
    cy.byTestId('login-email').invoke('val').should('not.be.empty');
  });
});
