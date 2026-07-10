/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Optional live/test-backend contract probe. It is intentionally outside the normal e2e spec pattern
 * so the offline gate never touches real services. READ-ONLY by design: it only GETs /api/v1/health
 * and shape-checks the response envelope — it must never mutate data.
 *
 * `--expose` (like `--config`) is a SINGLE-VALUE flag: pass it exactly once and comma-separate the
 * values — a repeated flag silently drops the earlier one. Local run (no dev server needed; baseUrl
 * is pointed at the live API so Cypress's reachability check probes the target itself, and
 * specPattern is overridden because this folder sits outside cypress/e2e):
 *   npm run e2e:live-contract -- \
 *     --expose "RUN_LIVE_API_CONTRACT=1,LIVE_API_BASE_URL=http://localhost:3000" \
 *     --config "baseUrl=http://localhost:3000,specPattern=cypress/live-contract/live-api-contract.cy.ts"
 * CI (web-live-contract job) passes the same flags with a glob specPattern; the spec self-skips
 * unless RUN_LIVE_API_CONTRACT=1 is exposed, so it can never leak into the offline gate.
 */
import { expectContract } from '../support/api-contracts';

describe('Live API contract smoke', () => {
  before(function skipUnlessExplicitlyEnabled() {
    if (String(Cypress.expose('RUN_LIVE_API_CONTRACT') ?? '') !== '1') this.skip();
  });

  it('validates the backend health response contract', () => {
    const baseUrl = String(Cypress.expose('LIVE_API_BASE_URL') ?? 'http://localhost:3000').replace(
      /\/$/,
      '',
    );

    cy.request({
      method: 'GET',
      url: `${baseUrl}/api/v1/health`,
      failOnStatusCode: false,
    }).then(response => {
      expect(response.status, 'health status').to.eq(200);
      expectContract('health', response.body);
    });
  });
});
