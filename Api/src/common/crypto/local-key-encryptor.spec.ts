/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { randomBytes } from 'node:crypto';
import { LocalKeyEncryptor } from './local-key-encryptor';

describe('LocalKeyEncryptor (envelope encryption)', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const aad = Buffer.from('customer-0190f8c2');
  const PLAINTEXT = '123-45-6789';

  it('#1 round-trips with the correct AAD and does not leak plaintext into the ciphertext', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const sealed = await enc.encrypt(Buffer.from(PLAINTEXT), aad);
    expect(sealed.keyId).toBe('k1');
    expect(sealed.ciphertext.includes(Buffer.from(PLAINTEXT))).toBe(false);
    expect((await enc.decrypt(sealed, aad)).toString()).toBe(PLAINTEXT);
  });

  it('#2 fails to decrypt under a different AAD (row mismatch → GCM auth tag)', async () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const sealed = await enc.encrypt(Buffer.from('secret'), aad);
    await expect(enc.decrypt(sealed, Buffer.from('customer-9999'))).rejects.toThrow();
  });

  it('#3 key rotation: new writes use the new keyId; old rows still decrypt under their keyId', async () => {
    const before = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const oldRow = await before.encrypt(Buffer.from('old'), aad);

    const rotated = new LocalKeyEncryptor(
      new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
      'k2',
    );
    const newRow = await rotated.encrypt(Buffer.from('new'), aad);
    expect(newRow.keyId).toBe('k2');
    expect((await rotated.decrypt(oldRow, aad)).toString()).toBe('old'); // retired key still decrypts
    expect((await rotated.decrypt(newRow, aad)).toString()).toBe('new');
  });

  it('rejects construction without a valid 32-byte active key', () => {
    expect(() => new LocalKeyEncryptor(new Map([['k1', randomBytes(16)]]), 'k1')).toThrow();
    expect(() => new LocalKeyEncryptor(new Map([['k1', k1]]), 'missing')).toThrow();
  });

  it('#5 blindIndex is deterministic and keyed (same input → same token; different input/key → different)', () => {
    const enc = new LocalKeyEncryptor(new Map([['k1', k1]]), 'k1');
    const a = enc.blindIndex(Buffer.from('12345678950'));
    expect(enc.blindIndex(Buffer.from('12345678950'))).toBe(a); // deterministic
    expect(enc.blindIndex(Buffer.from('98765432109'))).not.toBe(a); // distinct plaintext → distinct token
    expect(a).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    const other = new LocalKeyEncryptor(new Map([['k2', k2]]), 'k2');
    expect(other.blindIndex(Buffer.from('12345678950'))).not.toBe(a); // keyed: different master → different token
  });
});
