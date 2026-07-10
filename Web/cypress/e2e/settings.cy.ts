/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { settingsScreen } from '../support/screens/settings.screen';

describe('Enterprise settings flows', () => {
  it('drives profile, appearance, language, notifications, and access panels', () => {
    settingsScreen.visit();

    settingsScreen.updateProfileName('E2E Administrator Updated');
    cy.wait('@updateProfile').then(interception => {
      expect(interception.request.body).to.include({
        displayName: 'E2E Administrator Updated',
        phone: '+905551110000',
        jobTitle: 'Operations Lead',
      });
    });

    settingsScreen.openTab('appearance');
    // themeOptions render [light, dark, system]. The app BOOTS in `system` mode, so the initial
    // resolved theme follows the runner's prefers-color-scheme — pick light FIRST, then dark, so
    // at least one click is a real transition on any machine. Assert the REAL effect of the choice
    // (ThemeService): <html data-theme> flips and the mode persists under `theme-mode` (mirrored
    // to the legacy `theme` key) — not merely the radio's own selected state.
    cy.byTestId('settings-panel-appearance').find('[role="radio"]').eq(0).click();
    cy.document().its('documentElement').should('have.attr', 'data-theme', 'light');
    cy.byTestId('settings-panel-appearance').find('[role="radio"]').eq(1).click();
    cy.document().its('documentElement').should('have.attr', 'data-theme', 'dark');
    cy.window().its('localStorage').invoke('getItem', 'theme-mode').should('eq', 'dark');
    cy.window().its('localStorage').invoke('getItem', 'theme').should('eq', 'dark');

    settingsScreen.openTab('language');
    cy.byTestId('settings-panel-language').find('[role="radio"]').last().click();
    cy.window().its('localStorage').invoke('getItem', 'lang').should('eq', 'tr');

    settingsScreen.openTab('notifications');
    settingsScreen.toggleDigest();
    cy.wait('@updateNotificationPreferences').then(interception => {
      expect(interception.request.body).to.include({ weeklyDigest: true });
    });

    settingsScreen.openTab('access');
    cy.wait('@getHealth');
    cy.byTestId('settings-access-table').should('contain.text', 'customers');
    cy.byTestId('settings-access-facts').find('.access-fact').should('have.length.greaterThan', 0);
  });
});
