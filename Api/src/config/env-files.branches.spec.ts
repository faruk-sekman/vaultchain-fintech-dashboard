/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-completion tests for getApiEnvFilePaths. The sibling spec passes Development/Production
 * explicitly; this file fills the DEFAULT-parameter branch (read process.env.NODE_ENV), the
 * `nodeEnv?.` optional-chain undefined branch, and the `.trim()` whitespace branch around the
 * production check. Hermetic: only process.env.NODE_ENV is toggled and restored.
 */
import { getApiEnvFilePaths } from './env-files';

describe('getApiEnvFilePaths — branch completion', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('defaults to process.env.NODE_ENV when called with no argument (production env)', () => {
    process.env.NODE_ENV = 'production';
    const paths = getApiEnvFilePaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/[\\/]Api[\\/]\.env$/);
  });

  it('defaults to process.env.NODE_ENV when called with no argument (non-production env)', () => {
    process.env.NODE_ENV = 'test';
    const paths = getApiEnvFilePaths();
    expect(paths).toHaveLength(2);
    expect(paths[1]).toMatch(/[\\/]Api[\\/]\.env\.example$/);
  });

  it('falls back to dev paths when NODE_ENV is undefined (optional-chain undefined branch)', () => {
    delete process.env.NODE_ENV;
    const paths = getApiEnvFilePaths(undefined);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/[\\/]Api[\\/]\.env$/);
    expect(paths[1]).toMatch(/[\\/]Api[\\/]\.env\.example$/);
  });

  it('trims surrounding whitespace before the production comparison', () => {
    const paths = getApiEnvFilePaths('  production  ');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/[\\/]Api[\\/]\.env$/);
  });

  it('treats an empty string as non-production (dev fallback)', () => {
    const paths = getApiEnvFilePaths('');
    expect(paths).toHaveLength(2);
  });
});
