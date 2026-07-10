/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Custom commands. `cy.login()` performs a UI login against a stubbed backend (cy.intercept), so any
 * spec can reach the protected area in one line. The access token is held in memory by the app
 * — never web storage — so the success signal we assert is the non-sensitive `ftd_session`
 * presence hint, not a stored token.
 */

/** A canonical `authenticated` login response (envelope `{ data, meta }`). */
export const AUTH_RESPONSE = {
  data: {
    status: 'authenticated',
    accessToken: 'e2e-access-token',
    tokenType: 'Bearer',
    expiresIn: 900,
    permissions: ['customers.read', 'wallets.read', 'transactions.read'],
    // MeUserDto requires `lastLoginAt` (nullable) — the Settings "last sign-in" readout reads it.
    user: {
      id: 'u1',
      displayName: 'Demo Admin',
      email: 'a***@ftd.io',
      mfaEnabled: false,
      lastLoginAt: '2026-07-08T09:00:00.000Z',
    },
  },
  meta: { correlationId: 'e2e-corr' },
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /** Find an element by the project-wide stable E2E selector. */
      byTestId(
        id: string,
        options?: Partial<Loggable & Timeoutable>,
      ): Chainable<JQuery<HTMLElement>>;
      /** Find a child element by the project-wide stable E2E selector. */
      findByTestId(
        id: string,
        options?: Partial<Loggable & Timeoutable>,
      ): Chainable<JQuery<HTMLElement>>;
      /** Stub the auth endpoints + dashboard reads, then log in through the real form. */
      login(email?: string, password?: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add('byTestId', (id: string, options = {}) => {
  return cy.get(`[data-testid="${id}"]`, options);
});

Cypress.Commands.add(
  'findByTestId',
  { prevSubject: 'element' },
  (subject: JQuery<HTMLElement>, id: string, options = {}) => {
    return cy.wrap(subject).find(`[data-testid="${id}"]`, options);
  },
);

Cypress.Commands.add('login', (email = 'admin@ftd.io', password = 'Passw0rd!') => {
  // Catch-all for unstubbed reads first; specific auth stubs override it (last wins). An unstubbed
  // endpoint answers a REAL 404 error envelope (not a fake empty 200) so missing stubs stay visible.
  cy.intercept('GET', '**/api/v1/**', req => {
    // eslint-disable-next-line no-console
    console.warn(`[commands.login] Unstubbed GET → 404: ${req.url} (add an explicit stub)`);
    req.reply({
      statusCode: 404,
      body: {
        error: {
          code: 'Resource.NotFound',
          message: 'No stub for this endpoint.',
          correlationId: 'e2e-corr',
        },
      },
    });
  });
  cy.intercept('POST', '**/api/v1/auth/refresh', {
    statusCode: 401,
    body: {
      error: {
        code: 'Auth.TokenMissing',
        message: 'No session found. Please sign in.',
        correlationId: 'e2e-corr',
      },
    },
  });
  cy.intercept('POST', '**/api/v1/auth/login', { statusCode: 200, body: AUTH_RESPONSE }).as(
    'loginReq',
  );
  cy.intercept('GET', '**/api/v1/auth/me', {
    statusCode: 200,
    body: { data: { user: AUTH_RESPONSE.data.user, permissions: AUTH_RESPONSE.data.permissions } },
  });

  cy.visit('/login');
  cy.byTestId('login-email').clear().type(email);
  cy.byTestId('login-password').clear().type(password, { log: false });
  cy.byTestId('login-submit').click();
  cy.wait('@loginReq');
});

// Keep this a module so the global augmentation above is applied.
export {};
