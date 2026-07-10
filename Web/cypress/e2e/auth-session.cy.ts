/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { FULL_PERMISSIONS, stubEnterpriseApi, visitEnterprise } from '../support/enterprise-api';
import { appShell } from '../support/screens/app.screen';
import { loginScreen, mfaVerifyScreen } from '../support/screens/auth.screen';

describe('Enterprise auth session flows', () => {
  it('logs in, restores the session after a refresh, and logs out', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS });
    loginScreen.visit();
    loginScreen.login();
    cy.wait('@login');
    cy.url().should('include', '/dashboard');

    cy.window().its('localStorage').invoke('getItem', 'ftd_session').should('eq', '1');
    cy.window().then(win => {
      expect(win.localStorage.getItem('ftd_access_token')).to.be.null;
      expect(win.sessionStorage.getItem('ftd_access_token')).to.be.null;
      expect(win.localStorage.getItem('ftd_refresh_token')).to.be.null;
    });

    visitEnterprise('/dashboard', { sessionHint: true });
    cy.wait('@refreshSession').its('response.statusCode').should('eq', 200);
    cy.wait('@authMe');
    cy.url().should('include', '/dashboard');
    appShell.assertReady();
    appShell.logout();

    cy.wait('@logout').its('response.statusCode').should('eq', 204);
    cy.url().should('include', '/login');
    cy.window().its('localStorage').invoke('getItem', 'ftd_session').should('be.null');
  });

  it('routes MFA-required login to verify and sends trusted-device intent explicitly', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS, loginRequiresMfa: true, mfaEnabled: true });
    loginScreen.visit('/login?returnUrl=%2Fcustomers');

    loginScreen.login();

    cy.wait('@login').its('response.body.data.status').should('eq', 'mfa_required');
    cy.url().should('include', '/mfa/verify');

    mfaVerifyScreen.fillCode('123456');
    mfaVerifyScreen.rememberDevice();
    mfaVerifyScreen.submitTotp();

    cy.wait('@mfaVerify').then(interception => {
      expect(interception.request.body).to.deep.equal({
        code: '123456',
        rememberDevice: true,
      });
    });
    cy.url().should('include', '/customers');
  });
});
