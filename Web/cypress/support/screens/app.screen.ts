/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { FULL_PERMISSIONS, stubEnterpriseApi, visitEnterprise } from '../enterprise-api';
import { expectNoHorizontalOverflow } from '../quality';

export function visitAuthenticated(
  path: string,
  options: Parameters<typeof stubEnterpriseApi>[0] = { permissions: FULL_PERMISSIONS },
): void {
  stubEnterpriseApi(options);
  visitEnterprise(path, { sessionHint: true });
  cy.wait('@refreshSession');
  cy.wait('@authMe');
}

export class AppShellScreen {
  assertReady(): void {
    cy.byTestId('app-shell').should('be.visible');
    cy.byTestId('main-content').should('be.visible');
  }

  openUserMenu(): void {
    cy.byTestId('user-menu-trigger').should('be.visible').click();
    cy.get('.ui-menu__panel').should('be.visible');
  }

  logout(): void {
    this.openUserMenu();
    cy.get('.ui-menu__panel:visible .ui-menu__item--danger').first().click();
  }

  openMobileNavigation(): void {
    cy.byTestId('mobile-menu-trigger').should('be.visible').click();
    cy.byTestId('mobile-nav-panel').should('be.visible');
  }

  assertNoHorizontalOverflow(): void {
    expectNoHorizontalOverflow();
  }
}

export const appShell = new AppShellScreen();
