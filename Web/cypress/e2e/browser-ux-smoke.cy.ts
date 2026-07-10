/*
 * Browser UX smoke audit spec.
 *
 * This runs in the normal gate; the audit command only enables explicit screenshot artifacts.
 * It stubs backend calls, so it does not require a live API.
 */
import { FULL_PERMISSIONS, stubEnterpriseApi, visitEnterprise } from '../support/enterprise-api';
import { captureVisualArtifact, expectNoHorizontalOverflow } from '../support/quality';
import { loginScreen } from '../support/screens/auth.screen';

describe('Browser UX smoke audit', () => {
  it('desktop login renders primary controls without horizontal overflow', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    cy.viewport(1440, 900);
    visitEnterprise('/login');

    cy.byTestId('login-email').should('be.visible');
    cy.byTestId('login-password').should('be.visible');
    cy.byTestId('login-submit').should('be.visible');
    cy.byTestId('login-demo-card').should('have.length.greaterThan', 0);
    expectNoHorizontalOverflow();
    captureVisualArtifact('desktop-login');
  });

  it('mobile login keeps demo shortcuts usable without horizontal overflow', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    cy.viewport(390, 844);
    visitEnterprise('/login');

    cy.byTestId('login-email').should('be.visible');
    cy.byTestId('login-password').should('be.visible');
    loginScreen.chooseFirstDemoAccount();
    cy.byTestId('login-email').invoke('val').should('not.be.empty');
    expectNoHorizontalOverflow();
    captureVisualArtifact('mobile-login');
  });

  it('desktop authenticated dashboard reaches the main application shell', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    cy.viewport(1440, 900);
    visitEnterprise('/login');
    loginScreen.login('admin@ftd.local', 'Passw0rd!');
    cy.wait('@login');

    cy.url().should('include', '/dashboard');
    cy.get('body').should('be.visible');
    cy.get('body').should('not.contain.text', 'NaN');
    cy.get('body').should('not.contain.text', 'undefined%');
    expectNoHorizontalOverflow();
    captureVisualArtifact('desktop-dashboard');
  });
});
