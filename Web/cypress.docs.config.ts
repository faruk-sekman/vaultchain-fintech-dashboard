/*
 * Cypress config for the documentation screenshot lane ONLY (cypress/docs-screenshots/).
 *
 * Separate from cypress.config.ts on purpose: the docs lane renders the real Angular UI against
 * the contract-checked deterministic API fixtures used by the offline E2E suite. It needs a fixed
 * real browser window so every documentation frame is comparable. Nothing here affects CI.
 *
 * Run via: npm --prefix Web run e2e:docs-shots
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
    specPattern: 'cypress/docs-screenshots/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    fixturesFolder: 'cypress/fixtures',
    video: false,
    screenshotOnRunFailure: true,
    // Documentation standard: a 1600×1511 CSS viewport at 2× device scale, so the raw captures
    // land at 3200×3022. They are downsampled to 1600 px wide before being committed — the copy
    // step is spelled out under "Capture standard" in docs/screens.md.
    viewportWidth: 1600,
    viewportHeight: 1511,
    setupNodeEvents(on) {
      on('before:browser:launch', (browser, launchOptions) => {
        if (browser.family === 'chromium') {
          // 87px compensates headless window furniture so the inner viewport is a true 1600×1511.
          launchOptions.args.push('--window-size=1600,1598');
          launchOptions.args.push('--force-device-scale-factor=2');
        }
        return launchOptions;
      });
    },
  },
});
