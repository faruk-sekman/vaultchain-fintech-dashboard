/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { notificationsScreen } from '../support/screens/notifications.screen';

// Conditional alias for a filtered list call. Safe alongside the enterprise stub: this intercept
// only ASSIGNS `req.alias` and falls through; the stub's list handler claims its own default alias
// only when none is set yet (never overwrites this one).
function aliasNotificationListParam(alias: string, name: string, value: string): void {
  cy.intercept('GET', '**/api/v1/operator/notifications*', req => {
    const params = new URL(req.url).searchParams;
    if (params.get(name) === value) req.alias = alias;
  });
}

describe('Enterprise notification flows', () => {
  it('filters, marks read, marks all, and deep-links to the related record', () => {
    notificationsScreen.visit();
    notificationsScreen.assertRowsLoaded();
    // Two of the three seeded notifications are unread — visible via the unread row treatment.
    cy.get('.notif-row--unread').should('have.length', 2);

    aliasNotificationListParam('listKycNotifications', 'filter[type]', 'KYC_EVENT');
    notificationsScreen.filterTypeByIndex(2);
    cy.wait('@listKycNotifications');
    cy.get('[data-testid^="notification-row-"]').should('contain.text', 'KYC status updated');

    notificationsScreen.markFirstRead();
    cy.wait('@markReadNotification').then(interception => {
      expect(interception.request.url).to.include('/operator/notifications/notif-1/read');
    });

    notificationsScreen.markAllRead();
    cy.wait('@markAllNotifications').its('response.body.data.unreadCount').should('eq', 0);
    cy.wait('@listNotifications');
    // The user-visible outcome, not just the wire: every unread row treatment clears, the header
    // drops the unread summary, and the mark-all control disables itself.
    cy.get('.notif-row--unread').should('not.exist');
    cy.get('.notifications-page__summary--unread').should('not.exist');
    cy.byTestId('notifications-mark-all').should('be.disabled');

    notificationsScreen.openFirstNotification();
    cy.url().should('include', '/customers/c-1');
    cy.wait('@getCustomer');
    // Detail is the DEFAULT masked read surface — the deep link shows the masked name.
    cy.byTestId('customer-detail-summary').should('contain.text', 'Aylin K***');
  });
});
