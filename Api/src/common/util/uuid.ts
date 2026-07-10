/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * App-layer UUIDv7 generation: time-ordered ids for index locality, generated
 * at the service boundary rather than by a DB default (portability). No external dependency.
 */
import { randomFillSync } from 'node:crypto';

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// Monotonic state (RFC 9562 method 1): a 12-bit counter in the `rand_a` field makes ids minted
// within the SAME millisecond strictly increasing, so time-ordered consumers — notably the audit
// hash-chain's `ORDER BY created_at DESC, id DESC` predecessor selection — never tie-break onto the
// wrong row on same-millisecond appends and fork the chain (re-audit DATA-004). `rand_b` (bytes
// 9..15) stays random for cross-process uniqueness.
let lastMillis = -1;
let counter = 0;

/**
 * Generates a UUIDv7 (RFC 9562): 48-bit Unix-millis timestamp + a 12-bit intra-millisecond
 * monotonic counter (rand_a) + random bits (rand_b), with the version (7) and variant (10) nibbles
 * set. Strictly increasing within a process even for ids minted in the same millisecond.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  let timestamp = Date.now();
  if (timestamp > lastMillis) {
    lastMillis = timestamp;
    counter = 0;
  } else {
    // Same millisecond, or a backwards clock step (NTP): keep the counter strictly increasing. On
    // 12-bit overflow (>4096 ids in one ms — unreachable on the audit path) advance the logical
    // clock by a millisecond instead of wrapping, so ids never regress.
    counter += 1;
    if (counter > 0x0fff) {
      lastMillis += 1;
      counter = 0;
    }
    timestamp = lastMillis;
  }

  // 48-bit big-endian millisecond timestamp in bytes 0..5.
  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 (high nibble of byte 6) + the 12-bit monotonic counter in rand_a (byte6 low nibble +
  // byte7); RFC 4122 variant (top two bits of byte 8); rand_b (bytes 9..15) stays random.
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const h = HEX;
  return (
    h[bytes[0]] + h[bytes[1]] + h[bytes[2]] + h[bytes[3]] + '-' +
    h[bytes[4]] + h[bytes[5]] + '-' +
    h[bytes[6]] + h[bytes[7]] + '-' +
    h[bytes[8]] + h[bytes[9]] + '-' +
    h[bytes[10]] + h[bytes[11]] + h[bytes[12]] + h[bytes[13]] + h[bytes[14]] + h[bytes[15]]
  );
}
