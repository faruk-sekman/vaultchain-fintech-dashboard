/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import {
  captureVisualArtifact,
  expectA11ySmoke,
  expectNoHorizontalOverflow,
  expectPerformanceSmoke,
  expectVisualLayoutSmoke,
} from '../support/quality';
import { visitAuthenticated } from '../support/screens/app.screen';

describe('Enterprise quality smoke', () => {
  it('checks dashboard a11y, layout, performance, and desktop visual artifact hooks', () => {
    cy.viewport(1440, 900);
    visitAuthenticated('/dashboard');

    expectA11ySmoke();
    expectVisualLayoutSmoke();
    expectNoHorizontalOverflow();
    expectPerformanceSmoke();
    captureVisualArtifact('quality-dashboard-desktop');
  });

  it('checks mobile shell a11y and layout without horizontal overflow', () => {
    cy.viewport(390, 844);
    visitAuthenticated('/customers');
    cy.wait('@listCustomers');

    expectA11ySmoke();
    expectVisualLayoutSmoke();
    expectNoHorizontalOverflow();
    captureVisualArtifact('quality-customers-mobile');
  });
});
