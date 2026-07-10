/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * PII envelope-encryption binding (SEC-002/SEC-003). Provides the
 * `PII_ENCRYPTOR` token — an `EnvelopeEncryptor` used to column-encrypt high-sensitivity PII
 * (the national ID) on write. Key sourcing, in priority order:
 *
 *   1. `FTD_PII_MASTER_KEY` — a base64-encoded 32-byte master key (the production/staging path;
 *      sourced from a secret manager, never committed). `FTD_PII_KEY_ID` labels it (default `env-v1`).
 *   2. DEV-ONLY fallback — a deterministic, clearly non-secret key derived at boot. Used only when
 *      no env key is set AND `NODE_ENV !== 'production'`, with a loud one-time warning. It exists so
 *      a local backend works out of the box; it provides NO confidentiality and must never run in prod.
 *
 * In production with no `FTD_PII_MASTER_KEY`, the app fails fast at boot (same posture as
 * env.validation) rather than silently encrypting under a guessable key.
 *
 * The concrete cloud KMS (AWS/GCP/Vault) is a deploy-time binding implementing the same interface
 * and replaces this factory without touching callers (SEC-003).
 */
import { createHash } from 'node:crypto';
import { Global, Logger, Module } from '@nestjs/common';
import type { EnvelopeEncryptor } from './envelope-encryptor';
import { LocalKeyEncryptor } from './local-key-encryptor';

/** Injection token for the PII envelope encryptor. */
export const PII_ENCRYPTOR = Symbol('PII_ENCRYPTOR');

const MASTER_KEY_LEN = 32; // AES-256
const DEV_FALLBACK_KEY_ID = 'dev-fallback-v1';
/** Documented, non-secret seed for the dev-only fallback key (provides NO confidentiality). */
const DEV_FALLBACK_SEED = 'ftd-pii-dev-fallback-v1-NOT-FOR-PRODUCTION';

/**
 * Builds the PII encryptor from the environment. Exported (not just the module) so it can be
 * unit-tested and reused by offline tooling. Throws on a malformed env key or a prod boot with
 * no key configured.
 */
export function createPiiEncryptor(logger: Pick<Logger, 'warn'> = new Logger('PiiEncryptor')): {
  encryptor: EnvelopeEncryptor;
  keyId: string;
  source: 'env' | 'dev-fallback';
} {
  const raw = process.env.FTD_PII_MASTER_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== MASTER_KEY_LEN) {
      throw new Error(`FTD_PII_MASTER_KEY must be a base64-encoded ${MASTER_KEY_LEN}-byte key (got ${key.length} bytes).`);
    }
    const keyId = process.env.FTD_PII_KEY_ID?.trim() || 'env-v1';
    return { encryptor: new LocalKeyEncryptor(new Map([[keyId, key]]), keyId), keyId, source: 'env' };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('FTD_PII_MASTER_KEY is required in production (PII column encryption) — refusing to boot.');
  }

  logger.warn(
    'PII encryption is using the DEV-ONLY fallback key (FTD_PII_MASTER_KEY unset). ' +
      'This provides NO confidentiality and must never be used outside local development.',
  );
  const devKey = createHash('sha256').update(DEV_FALLBACK_SEED).digest(); // 32 bytes
  return {
    encryptor: new LocalKeyEncryptor(new Map([[DEV_FALLBACK_KEY_ID, devKey]]), DEV_FALLBACK_KEY_ID),
    keyId: DEV_FALLBACK_KEY_ID,
    source: 'dev-fallback',
  };
}

@Global()
@Module({
  providers: [{ provide: PII_ENCRYPTOR, useFactory: (): EnvelopeEncryptor => createPiiEncryptor().encryptor }],
  exports: [PII_ENCRYPTOR],
})
export class CryptoModule {}
