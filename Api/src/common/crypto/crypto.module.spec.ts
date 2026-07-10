/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { randomBytes } from 'node:crypto';
import { createPiiEncryptor } from './crypto.module';
import { packEnvelope, unpackEnvelope } from './envelope-codec';

describe('createPiiEncryptor', () => {
  const ORIGINAL = { key: process.env.FTD_PII_MASTER_KEY, keyId: process.env.FTD_PII_KEY_ID, env: process.env.NODE_ENV };
  const silentLogger = { warn: (): void => undefined };

  afterEach(() => {
    process.env.FTD_PII_MASTER_KEY = ORIGINAL.key;
    process.env.FTD_PII_KEY_ID = ORIGINAL.keyId;
    process.env.NODE_ENV = ORIGINAL.env;
  });

  it('uses the env master key when present (base64 32 bytes) and labels it', async () => {
    process.env.FTD_PII_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.FTD_PII_KEY_ID = 'env-v1';
    delete process.env.NODE_ENV;

    const { encryptor, keyId, source } = createPiiEncryptor(silentLogger);
    expect(source).toBe('env');
    expect(keyId).toBe('env-v1');

    const aad = Buffer.from('customer:abc');
    const sealed = await encryptor.encrypt(Buffer.from('10000000146'), aad);
    expect(sealed.keyId).toBe('env-v1');
    expect((await encryptor.decrypt(unpackEnvelope(packEnvelope(sealed)), aad)).toString()).toBe('10000000146');
  });

  it('rejects a master key that is not 32 bytes', () => {
    process.env.FTD_PII_MASTER_KEY = randomBytes(16).toString('base64');
    delete process.env.NODE_ENV;
    expect(() => createPiiEncryptor(silentLogger)).toThrow(/32-byte/);
  });

  it('fails fast in production when no key is configured', () => {
    delete process.env.FTD_PII_MASTER_KEY;
    process.env.NODE_ENV = 'production';
    expect(() => createPiiEncryptor(silentLogger)).toThrow(/required in production/);
  });

  it('falls back to a deterministic dev key outside production', async () => {
    delete process.env.FTD_PII_MASTER_KEY;
    process.env.NODE_ENV = 'development';

    const a = createPiiEncryptor(silentLogger);
    const b = createPiiEncryptor(silentLogger);
    expect(a.source).toBe('dev-fallback');
    expect(a.keyId).toBe('dev-fallback-v1');

    // Deterministic: a row sealed by one instance decrypts under another (survives restarts).
    const aad = Buffer.from('customer:xyz');
    const sealed = await a.encryptor.encrypt(Buffer.from('secret'), aad);
    expect((await b.encryptor.decrypt(sealed, aad)).toString()).toBe('secret');
  });
});
