/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, expect, it } from 'vitest';
import {
  API_VERSION_PATH as DEV_API_VERSION_PATH,
  environment as devEnvironment,
} from './environment';
import {
  API_VERSION_PATH as STAGE_API_VERSION_PATH,
  environment as stageEnvironment,
} from './environment.stage';
import {
  API_VERSION_PATH as PROD_API_VERSION_PATH,
  environment as prodEnvironment,
} from './environment.prod';

describe('environment apiBaseUrl contract', () => {
  it('keeps the API version segment consistent across dev, stage, and prod', () => {
    expect(DEV_API_VERSION_PATH).toBe('/api/v1');
    expect(STAGE_API_VERSION_PATH).toBe(DEV_API_VERSION_PATH);
    expect(PROD_API_VERSION_PATH).toBe(DEV_API_VERSION_PATH);

    for (const env of [devEnvironment, stageEnvironment, prodEnvironment]) {
      expect(env.apiBaseUrl).toMatch(/\/api\/v1$/);
      expect(env.apiBaseUrl).not.toMatch(/\/api\/v1\/api\/v1$/);
    }
  });

  it('keeps stage/prod API calls on the frontend origin', () => {
    expect(stageEnvironment.apiBaseUrl).toBe('/api/v1');
    expect(prodEnvironment.apiBaseUrl).toBe('/api/v1');
    expect(stageEnvironment.apiBaseUrl).not.toContain('frontend-case-study.onrender.com');
    expect(prodEnvironment.apiBaseUrl).not.toContain('frontend-case-study.onrender.com');
  });
});
