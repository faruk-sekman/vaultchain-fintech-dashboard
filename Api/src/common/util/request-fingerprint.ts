/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Canonical request fingerprint for the idempotency contract. Same logical
 * request ⇒ same fingerprint, so a replayed Idempotency-Key with the same body returns the
 * stored response, while the same key with a different body is a conflict.
 */
import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, `undefined`/null-valued keys dropped,
 * arrays preserved in order. Money is already integer-minor upstream (no float normalization).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined || v === null) {
        continue;
      }
      result[key] = sortValue(v);
    }
    return result;
  }
  return value;
}

/** SHA-256 of the canonical form, hex-encoded. */
export function fingerprintRequest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
