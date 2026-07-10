/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Runtime env file selection. Local development may fall back to the checked-in template so the
 * API can boot with documented dev-only placeholders; production never uses the template.
 */
import { join } from 'node:path';
import { NodeEnv } from './env.validation';

const API_ENV_FILE_PATH = join(__dirname, '..', '..', '.env');
const API_ENV_EXAMPLE_FILE_PATH = join(__dirname, '..', '..', '.env.example');

export function getApiEnvFilePaths(nodeEnv = process.env.NODE_ENV): string[] {
  if (nodeEnv?.trim() === NodeEnv.Production) {
    return [API_ENV_FILE_PATH];
  }

  return [API_ENV_FILE_PATH, API_ENV_EXAMPLE_FILE_PATH];
}
