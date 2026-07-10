/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { visitAuthenticated } from './app.screen';

export class NotificationsScreen {
  visit(): void {
    visitAuthenticated('/notifications');
    cy.wait('@listNotifications');
  }

  assertRowsLoaded(): void {
    cy.get('[data-testid^="notification-row-"]').should('have.length.greaterThan', 0);
  }

  filterTypeByIndex(index: number): void {
    cy.byTestId('notifications-filter-type').find('select').select(index);
  }

  markFirstRead(): void {
    cy.get('[data-testid^="notification-mark-read-"]').first().click();
  }

  markAllRead(): void {
    cy.byTestId('notifications-mark-all').click();
  }

  openFirstNotification(): void {
    cy.get('[data-testid^="notification-open-"]').first().click();
  }
}

export const notificationsScreen = new NotificationsScreen();
