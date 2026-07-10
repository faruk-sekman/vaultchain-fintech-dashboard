/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import {
  FULL_PERMISSIONS,
  loginEnterprise,
  stubEnterpriseApi,
  visitEnterprise,
} from '../support/enterprise-api';
import { loginScreen } from '../support/screens/auth.screen';

/** Open the Settings security panel from a fresh authenticated visit. */
function visitSecurityPanel(options: { mfaEnabled: boolean }): void {
  loginEnterprise({ permissions: FULL_PERMISSIONS, mfaEnabled: options.mfaEnabled });
  visitEnterprise('/settings?section=security', { sessionHint: true });
  cy.wait('@refreshSession');
  cy.wait('@listMfaDevices');
}

/** Fill the security panel's re-auth (password + current code) form and submit it. */
function submitReauth(password: string, code: string): void {
  cy.get('.settings-mfa-reauth').should('be.visible');
  cy.get('#mfa-reauth-password').type(password, { log: false });
  cy.get('#mfa-reauth-code').type(code);
  cy.get('.settings-mfa-reauth button[type="submit"]').click();
}

describe('Enterprise MFA flows', () => {
  it('enrolls MFA in the Settings drawer and gates backup-code dismissal', () => {
    loginEnterprise({ permissions: FULL_PERMISSIONS, mfaEnabled: false });
    visitEnterprise('/settings/mfa', { sessionHint: true });

    cy.wait('@refreshSession');
    // Step 1 — re-auth: wait on the drawer's slide-in via a visible-state assertion (no force).
    cy.byTestId('mfa-setup-password-input', { timeout: 12000 }).should('be.visible');
    cy.byTestId('mfa-setup-password-input').type('Passw0rd!', { log: false });
    cy.byTestId('mfa-setup-password-submit').find('button').click();

    cy.wait('@mfaSetupStart').then(interception => {
      expect(interception.request.body).to.deep.equal({ password: 'Passw0rd!' });
    });

    // Step 2 — scan + confirm. The drawer body is a scroll container and the code field sits below
    // the QR block, so Cypress's clipping rule marks it "not visible" until it is scrolled to —
    // THIS is what the old `{ force: true }` was papering over. Scrolling is the honest fix.
    cy.byTestId('mfa-setup-code-input').scrollIntoView().should('be.visible').type('123456');
    cy.byTestId('mfa-setup-verify-submit').scrollIntoView().find('button').click();

    cy.wait('@mfaSetupConfirm').then(interception => {
      expect(interception.request.body).to.deep.equal({ code: '123456' });
    });

    // Step 3 — backup codes: Done stays disabled until the "codes saved" confirmation is checked.
    cy.get('.mfa-setup__codes').should('contain.text', 'ABCD1-EFGH2');
    cy.byTestId('mfa-setup-finish').scrollIntoView().find('button').should('be.disabled');
    cy.byTestId('mfa-setup-codes-saved-checkbox').scrollIntoView().check();
    cy.byTestId('mfa-setup-codes-saved-checkbox').should('be.checked');
    cy.byTestId('mfa-setup-finish').find('button').should('not.be.disabled').click();

    cy.get('.mfa-setup').should('not.exist');
    cy.url().should('include', 'section=security');
  });

  it('logs in with a one-time backup code when the authenticator is unavailable', () => {
    stubEnterpriseApi({ permissions: FULL_PERMISSIONS, loginRequiresMfa: true, mfaEnabled: true });
    loginScreen.visit();
    loginScreen.login();
    cy.wait('@login');
    cy.url().should('include', '/mfa/verify');

    // Switch to the backup-code path, then complete login with a one-time code.
    cy.get('.mfa-verify__actions .mfa-verify__link').first().click();
    cy.get('#mfa-backup-code').should('be.visible').type('ABCD1-EFGH2');
    cy.get('.mfa-verify__form button[type="submit"]').click();

    cy.wait('@mfaBackupVerify').its('request.body').should('deep.equal', { code: 'ABCD1-EFGH2' });
    cy.url().should('include', '/dashboard');
  });

  it('treats trusted-device revoke as idempotent — every revoke answers 204 and the list converges', () => {
    visitSecurityPanel({ mfaEnabled: true });

    cy.contains('.settings-device', '10.24.8.0/24').within(() => {
      cy.get('button').click();
    });
    cy.get('.confirm-card .ui-button--danger').click();
    cy.wait('@revokeMfaDevice').its('response.statusCode').should('eq', 204);
    cy.contains('.settings-device', '10.24.8.0/24').should('not.exist');
    cy.contains('.settings-device', '10.30.12.0/24').should('be.visible');

    // Real backend semantics (remembered-device.service.ts): DELETE is a `updateMany where
    // revokedAt: null` no-op for an already-revoked/gone device and STILL answers 204 — there is
    // no `Mfa.DeviceAlreadyRevoked` error on the wire. Revoking the last device converges the
    // list to its empty state through the same idempotent 204.
    cy.contains('.settings-device', '10.30.12.0/24').within(() => {
      cy.get('button').click();
    });
    cy.get('.confirm-card .ui-button--danger').click();
    cy.wait('@revokeMfaDevice').its('response.statusCode').should('eq', 204);
    cy.get('.settings-device').should('not.exist');
    cy.get('.settings-devices__empty').should('be.visible');
  });

  it('disables MFA after re-authentication and returns the panel to its enrol state', () => {
    visitSecurityPanel({ mfaEnabled: true });

    cy.byTestId('settings-panel-security')
      .find('.settings-actions--split app-ui-button[variant="danger"] button')
      .click();
    submitReauth('Passw0rd!', '123456');

    cy.wait('@mfaDisable')
      .its('request.body')
      .should('deep.equal', { password: 'Passw0rd!', code: '123456' });
    // UI outcome: the enabled-only action pair disappears and the enrol CTA returns.
    cy.byTestId('settings-panel-security').find('.settings-actions--split').should('not.exist');
    cy.byTestId('settings-panel-security').find('.settings-mfa-reauth').should('not.exist');
  });

  it('regenerates backup codes after re-authentication and gates dismissal on saving them', () => {
    visitSecurityPanel({ mfaEnabled: true });

    cy.byTestId('settings-panel-security')
      .find('.settings-actions--split app-ui-button[variant="ghost"] button')
      .click();
    submitReauth('Passw0rd!', '654321');

    cy.wait('@mfaRegenerateBackupCodes')
      .its('request.body')
      .should('deep.equal', { password: 'Passw0rd!', code: '654321' });

    // The NEW one-time codes render, and dismissal is gated on the saved confirmation. The Done
    // button is the `.settings-actions` SIBLING of the saved-confirmation label (the panel has
    // other `.settings-actions` blocks, e.g. the admin-reset sections).
    cy.get('.settings-backup-codes').should('contain.text', 'ZXCV1-ASDF2');
    cy.get('.settings-mfa-saved')
      .siblings('.settings-actions')
      .find('button')
      .should('be.disabled');
    cy.get('.settings-mfa-saved input[type="checkbox"]').check();
    cy.get('.settings-mfa-saved')
      .siblings('.settings-actions')
      .find('button')
      .should('not.be.disabled')
      .click();
    cy.get('.settings-backup-codes').should('not.exist');
  });
});
