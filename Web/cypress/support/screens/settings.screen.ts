/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { visitAuthenticated } from './app.screen';

export class SettingsScreen {
  visit(): void {
    visitAuthenticated('/settings');
    cy.wait('@getProfile');
    cy.wait('@getNotificationPreferences');
    cy.byTestId('settings-panel-profile', { timeout: 12000 }).should('be.visible');
  }

  openTab(section: 'appearance' | 'language' | 'notifications' | 'access'): void {
    cy.byTestId(`settings-tab-${section}`).click();
    cy.byTestId(`settings-panel-${section}`).should('be.visible');
  }

  updateProfileName(name: string): void {
    cy.byTestId('settings-profile-name').find('input').clear().type(name);
    cy.byTestId('settings-profile-save').find('button').click();
  }

  toggleDigest(): void {
    cy.byTestId('settings-notifications-digest').find('button').click();
  }
}

export const settingsScreen = new SettingsScreen();
