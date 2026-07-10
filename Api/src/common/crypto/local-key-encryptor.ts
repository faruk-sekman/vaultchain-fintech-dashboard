/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dependency-free EnvelopeEncryptor fallback: AES-256-GCM with a local master-key
 * ring. No cloud KMS — suitable for dev/test and as the seam a real provider replaces at deploy.
 * Master keys are passed in (never hard-coded); a real deployment sources them from a secret manager.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { EnvelopeCiphertext, EnvelopeEncryptor } from './envelope-encryptor';

const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
// HKDF `info` label that domain-separates the blind-index key from the encryption use of the same master.
const BLIND_INDEX_INFO = Buffer.from('ftd-national-id-blind-index-v1', 'utf8');

export class LocalKeyEncryptor implements EnvelopeEncryptor {
  constructor(
    private readonly keyring: ReadonlyMap<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    const master = keyring.get(activeKeyId);
    if (!master || master.length !== KEY_LEN) {
      throw new Error('LocalKeyEncryptor: the active key must be a 32-byte key present in the keyring.');
    }
  }

  // async so a synchronous GCM/crypto failure surfaces as a rejected promise (not a sync throw).
  async encrypt(plaintext: Buffer, aad: Buffer): Promise<EnvelopeCiphertext> {
    const masterKey = this.keyring.get(this.activeKeyId)!;
    const dataKey = randomBytes(KEY_LEN);
    const ciphertext = seal(dataKey, plaintext, aad);
    const wrappedDataKey = seal(masterKey, dataKey, Buffer.from(this.activeKeyId, 'utf8'));
    return { ciphertext, wrappedDataKey, keyId: this.activeKeyId };
  }

  async decrypt(input: EnvelopeCiphertext, aad: Buffer): Promise<Buffer> {
    const masterKey = this.keyring.get(input.keyId);
    if (!masterKey) throw new Error(`LocalKeyEncryptor: unknown keyId "${input.keyId}".`);
    const dataKey = open(masterKey, input.wrappedDataKey, Buffer.from(input.keyId, 'utf8'));
    return open(dataKey, input.ciphertext, aad);
  }

  blindIndex(plaintext: Buffer): string {
    const masterKey = this.keyring.get(this.activeKeyId)!;
    // HKDF a dedicated key from the master so the blind index is cryptographically separated from the
    // encryption key; HMAC-SHA256 then makes it deterministic (so a UNIQUE index can use it) yet
    // unforgeable and non-brute-forceable offline by anyone without the master key.
    const biKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), BLIND_INDEX_INFO, KEY_LEN));
    return createHmac('sha256', biKey).update(plaintext).digest('hex');
  }
}

/** AES-256-GCM seal → [iv(12) ‖ tag(16) ‖ ciphertext]. */
function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/** AES-256-GCM open — throws on a wrong key/AAD (auth-tag mismatch). */
function open(key: Buffer, packed: Buffer, aad: Buffer): Buffer {
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
