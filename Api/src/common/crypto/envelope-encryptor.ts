/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * KMS-agnostic envelope-encryption port for high-sensitivity PII.
 * A random per-value data key encrypts the plaintext (AES-256-GCM); the data key is wrapped by a
 * master key. `keyId` identifies the master key so rotation re-wraps without re-encrypting plaintext.
 * `aad` binds ciphertext to its row (e.g. customer_id) so a stolen blob can't be replanted.
 *
 * The concrete cloud provider (AWS KMS / GCP KMS / Vault) is a deploy-time binding implementing this
 * same interface; `LocalKeyEncryptor` is the dependency-free fallback.
 */
export interface EnvelopeCiphertext {
  ciphertext: Buffer;
  wrappedDataKey: Buffer;
  keyId: string;
}

export interface EnvelopeEncryptor {
  encrypt(plaintext: Buffer, aad: Buffer): Promise<EnvelopeCiphertext>;
  decrypt(input: EnvelopeCiphertext, aad: Buffer): Promise<Buffer>;
  /**
   * Deterministic keyed blind index (HMAC-SHA256) of a plaintext value — the same input always maps to
   * the same opaque token. Lets a UNIQUE constraint enforce plaintext uniqueness over a randomized-
   * ciphertext column (envelope encryption uses a random IV, so the ciphertext itself can't be uniqued).
   * The HMAC key is derived from the master key, so the index is unforgeable and not brute-forceable
   * offline by anyone without the master key, yet safe to store beside the row.
   */
  blindIndex(plaintext: Buffer): string;
}
