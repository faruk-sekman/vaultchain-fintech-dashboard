/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-completion tests for envelope-codec. The sibling spec covers the
 * happy round-trip + truncated-header throw; this file fills the remaining guard branches: the
 * empty-blob throw, keyId-too-long (>255B) and wrappedDataKey-too-long (>65535B) pack guards, the
 * truncated-wrapped-data-key unpack throw, and a zero-length-ciphertext edge round-trip.
 */
import { randomBytes } from 'node:crypto';
import { packEnvelope, unpackEnvelope } from './envelope-codec';
import type { EnvelopeCiphertext } from './envelope-encryptor';

describe('envelope-codec — branch completion', () => {
  it('throws on an EMPTY blob (length < 1 byte header)', () => {
    expect(() => unpackEnvelope(Buffer.alloc(0))).toThrow(/empty blob/);
  });

  it('packEnvelope throws when keyId exceeds the u8 length field (>255 bytes)', () => {
    const env: EnvelopeCiphertext = {
      keyId: 'k'.repeat(256), // 256 ASCII bytes > MAX_KEY_ID_LEN (0xff)
      wrappedDataKey: randomBytes(8),
      ciphertext: randomBytes(8),
    };
    expect(() => packEnvelope(env)).toThrow(/keyId too long/);
  });

  it('accepts a maximal 255-byte keyId (the u8 boundary) and round-trips it', () => {
    const keyId = 'k'.repeat(255);
    const env: EnvelopeCiphertext = { keyId, wrappedDataKey: randomBytes(8), ciphertext: randomBytes(8) };
    expect(unpackEnvelope(packEnvelope(env)).keyId).toBe(keyId);
  });

  it('packEnvelope throws when wrappedDataKey exceeds the u16 length field (>65535 bytes)', () => {
    const env: EnvelopeCiphertext = {
      keyId: 'k1',
      wrappedDataKey: Buffer.alloc(0x10000), // 65536 > MAX_WDK_LEN (0xffff)
      ciphertext: randomBytes(4),
    };
    expect(() => packEnvelope(env)).toThrow(/wrappedDataKey too long/);
  });

  it('throws on a blob truncated mid wrapped-data-key (header claims more than is present)', () => {
    const env: EnvelopeCiphertext = {
      keyId: 'k1',
      wrappedDataKey: randomBytes(60),
      ciphertext: randomBytes(20),
    };
    const packed = packEnvelope(env);
    // Keep the full header (1 + 2 + len(keyId) = 5 bytes) but cut into the wrapped data key.
    const cutInsideWdk = packed.subarray(0, 10);
    expect(() => unpackEnvelope(cutInsideWdk)).toThrow(/truncated wrapped data key/);
  });

  it('round-trips an envelope with a zero-length ciphertext (subarray tail edge)', () => {
    const env: EnvelopeCiphertext = {
      keyId: 'k1',
      wrappedDataKey: randomBytes(16),
      ciphertext: Buffer.alloc(0),
    };
    const restored = unpackEnvelope(packEnvelope(env));
    expect(restored.keyId).toBe('k1');
    expect(restored.ciphertext.length).toBe(0);
    expect(restored.wrappedDataKey.equals(env.wrappedDataKey)).toBe(true);
  });
});
