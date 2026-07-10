/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { randomBytes } from 'node:crypto';
import { packEnvelope, unpackEnvelope } from './envelope-codec';
import { LocalKeyEncryptor } from './local-key-encryptor';

describe('envelope-codec (pack/unpack)', () => {
  it('round-trips an envelope through pack → unpack', () => {
    const env = { ciphertext: randomBytes(40), wrappedDataKey: randomBytes(60), keyId: 'env-v1' };
    const restored = unpackEnvelope(packEnvelope(env));
    expect(restored.keyId).toBe('env-v1');
    expect(restored.wrappedDataKey.equals(env.wrappedDataKey)).toBe(true);
    expect(restored.ciphertext.equals(env.ciphertext)).toBe(true);
  });

  it('round-trips a real encrypt → pack → unpack → decrypt', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', randomBytes(32)]]), 'k1');
    const aad = Buffer.from('customer:0190f8c2');
    const sealed = await enc.encrypt(Buffer.from('10000000146'), aad);
    const restored = unpackEnvelope(packEnvelope(sealed));
    expect((await enc.decrypt(restored, aad)).toString()).toBe('10000000146');
  });

  it('throws on a truncated blob', () => {
    const env = { ciphertext: randomBytes(8), wrappedDataKey: randomBytes(60), keyId: 'k1' };
    const packed = packEnvelope(env);
    expect(() => unpackEnvelope(packed.subarray(0, 3))).toThrow();
  });
});
