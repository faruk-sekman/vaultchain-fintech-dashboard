/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-completion tests for LocalKeyEncryptor. The sibling spec covers the
 * round-trip, wrong-AAD rejection, rotation, and construction guards; this file fills the
 * decrypt-with-UNKNOWN-keyId throw and the ciphertext/wrapped-key TAMPER (GCM auth-tag) branches.
 */
import { randomBytes } from 'node:crypto';
import { LocalKeyEncryptor } from './local-key-encryptor';
import type { EnvelopeCiphertext } from './envelope-encryptor';

describe('LocalKeyEncryptor — branch completion', () => {
  const k1 = randomBytes(32);
  const aad = Buffer.from('customer-tamper');

  it('decrypt throws for a keyId that is not in the keyring (rotation/foreign blob)', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const sealed = await enc.encrypt(Buffer.from('x'), aad);
    const foreign: EnvelopeCiphertext = { ...sealed, keyId: 'k-unknown' };

    await expect(enc.decrypt(foreign, aad)).rejects.toThrow(/unknown keyId "k-unknown"/);
  });

  it('decrypt rejects a TAMPERED ciphertext (flipped byte → GCM tag mismatch)', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const sealed = await enc.encrypt(Buffer.from('sensitive-pii'), aad);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] ^= 0x01; // flip the last ciphertext byte
    const corrupted: EnvelopeCiphertext = { ...sealed, ciphertext: tampered };

    await expect(enc.decrypt(corrupted, aad)).rejects.toThrow();
  });

  it('decrypt rejects a TAMPERED wrapped data key (data-key unwrap fails first)', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const sealed = await enc.encrypt(Buffer.from('sensitive-pii'), aad);
    const wdk = Buffer.from(sealed.wrappedDataKey);
    wdk[0] ^= 0xff; // corrupt the IV/region of the wrapped key blob
    const corrupted: EnvelopeCiphertext = { ...sealed, wrappedDataKey: wdk };

    await expect(enc.decrypt(corrupted, aad)).rejects.toThrow();
  });

  it('the data key is per-value: two encryptions of the same plaintext produce different blobs', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const a = await enc.encrypt(Buffer.from('same'), aad);
    const b = await enc.encrypt(Buffer.from('same'), aad);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDataKey.equals(b.wrappedDataKey)).toBe(false);
  });
});
