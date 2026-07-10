/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { getApiEnvFilePaths } from './env-files';
import { NodeEnv } from './env.validation';

describe('getApiEnvFilePaths', () => {
  it('uses the local example file as a development fallback', () => {
    const paths = getApiEnvFilePaths(NodeEnv.Development);

    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/[\\/]Api[\\/]\.env$/);
    expect(paths[1]).toMatch(/[\\/]Api[\\/]\.env\.example$/);
  });

  it('does not use the example file in production', () => {
    const paths = getApiEnvFilePaths(NodeEnv.Production);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/[\\/]Api[\\/]\.env$/);
  });
});
