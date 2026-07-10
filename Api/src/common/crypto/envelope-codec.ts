/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Serializes an EnvelopeCiphertext into the single `Bytes` column that
 * stores it (`customers.national_id_enc`) and back. The `keyId` is packed alongside the wrapped
 * data key + ciphertext so a row remains self-describing for key rotation — a future read knows
 * which master key wrapped it without an out-of-band lookup.
 *
 * Layout (big-endian lengths):
 *   [keyIdLen: u8][keyId][wrappedDataKeyLen: u16][wrappedDataKey][ciphertext…]
 */
import type { EnvelopeCiphertext } from './envelope-encryptor';

const KEY_ID_LEN_BYTES = 1;
const WDK_LEN_BYTES = 2;
const MAX_KEY_ID_LEN = 0xff;
const MAX_WDK_LEN = 0xffff;

/** Pack the envelope into one buffer for storage in a `Bytes` column. */
export function packEnvelope(envelope: EnvelopeCiphertext): Buffer {
  const keyId = Buffer.from(envelope.keyId, 'utf8');
  if (keyId.length > MAX_KEY_ID_LEN) throw new Error('packEnvelope: keyId too long.');
  if (envelope.wrappedDataKey.length > MAX_WDK_LEN) throw new Error('packEnvelope: wrappedDataKey too long.');

  const header = Buffer.alloc(KEY_ID_LEN_BYTES + keyId.length + WDK_LEN_BYTES);
  header.writeUInt8(keyId.length, 0);
  keyId.copy(header, KEY_ID_LEN_BYTES);
  header.writeUInt16BE(envelope.wrappedDataKey.length, KEY_ID_LEN_BYTES + keyId.length);

  return Buffer.concat([header, envelope.wrappedDataKey, envelope.ciphertext]);
}

/** Reverse {@link packEnvelope}. Throws on a truncated/corrupt blob. */
export function unpackEnvelope(packed: Buffer): EnvelopeCiphertext {
  if (packed.length < KEY_ID_LEN_BYTES) throw new Error('unpackEnvelope: empty blob.');
  const keyIdLen = packed.readUInt8(0);
  let offset = KEY_ID_LEN_BYTES;

  if (packed.length < offset + keyIdLen + WDK_LEN_BYTES) throw new Error('unpackEnvelope: truncated header.');
  const keyId = packed.subarray(offset, offset + keyIdLen).toString('utf8');
  offset += keyIdLen;

  const wdkLen = packed.readUInt16BE(offset);
  offset += WDK_LEN_BYTES;

  if (packed.length < offset + wdkLen) throw new Error('unpackEnvelope: truncated wrapped data key.');
  const wrappedDataKey = packed.subarray(offset, offset + wdkLen);
  offset += wdkLen;

  const ciphertext = packed.subarray(offset);
  return { ciphertext, wrappedDataKey, keyId };
}
