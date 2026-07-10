/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Cypress E2E config (TASK-QA — operator auth flow). Drives the real app in a browser against a
 * locally-served dev build (`npm start` → http://localhost:4200); all backend calls are stubbed with
 * cy.intercept so the E2E needs no live API/DB. Run: `npm start` in one shell, then
 * `npx cypress run --project .` (or `npx cypress open`).
 */
import { defineConfig } from 'cypress';

export default defineConfig({
  allowCypressEnv: false,
  downloadsFolder: 'cypress/artifacts/downloads',
  screenshotsFolder: 'cypress/artifacts/screenshots',
  videosFolder: 'cypress/artifacts/videos',
  trashAssetsBeforeRuns: true,
  retries: {
    runMode: 1,
    openMode: 0,
  },
  e2e: {
    baseUrl: 'http://localhost:4200',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    fixturesFolder: 'cypress/fixtures',
    video: false,
    screenshotOnRunFailure: true,
  },
});
