/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Money is stored and computed as BigInt minor-units; it crosses the response/wire boundary as a
 * JSON STRING of the exact integer minor-units (audit O-10), NOT a JS `number`. The
 * string wire-format is lossless for any magnitude and frees the FE from IEEE-754 precision limits.
 *
 * `minorToSafeNumber` remains the in-process narrowing to a JS `number` (used where a number is still
 * needed — e.g. audit-context numerics); it FAILS LOUDLY above Number.MAX_SAFE_INTEGER (2^53-1)
 * instead of silently truncating. `minorToWireString` is the response/wire serializer.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Narrow a BigInt minor-unit amount to a JS number. Throws when the value cannot be represented
 * exactly, so an out-of-range amount fails loudly (caught by the global exception filter → 500 +
 * correlationId, logged server-side) rather than corrupting money. `field` names the column for the
 * error message.
 */
export function minorToSafeNumber(value: bigint, field = 'amount'): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new RangeError(
      `Money value for "${field}" (${value.toString()} minor units) exceeds the safe JS integer range; refusing to truncate.`,
    );
  }
  return Number(value);
}

/**
 * Serialize a money minor-unit amount (a BigInt, or an already-narrowed integer number) to the
 * canonical wire STRING — a base-10 representation of the exact integer (e.g. 1234500n → "1234500").
 * This is the single money serializer for response DTOs; the FE mirrors this contract exactly.
 *
 * A `number` input is asserted to be a safe integer first, so an accidental float/unsafe value fails
 * loudly here rather than serializing a lossy money string. A BigInt is always exact.
 */
export function minorToWireString(value: bigint | number, field = 'amount'): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Money value for "${field}" (${value}) is not a safe integer; refusing to serialize a lossy money string.`,
      );
    }
    return value.toString();
  }
  return value.toString();
}

/**
 * Convert a MAJOR-unit amount (e.g. 5000 = ₺5000.00) to integer minor units for a currency whose
 * minor unit has `scale` decimal digits (2 for TRY/USD/EUR, 0 for JPY, 3 for KWD). Uses the real
 * per-currency scale instead of a hardcoded ×100, and fails loudly on a non-finite input or an
 * out-of-safe-range result rather than silently corrupting money (re-audit BE-001 — this is the
 * canonical major→minor helper the codebase was missing, ARCH-006). `field` names the column.
 */
export function majorToMinor(major: number, scale: number, field = 'amount'): bigint {
  if (!Number.isFinite(major)) {
    throw new RangeError(`Money value for "${field}" (${major}) is not a finite number.`);
  }
  const scaled = Math.round(major * 10 ** scale);
  if (!Number.isSafeInteger(scaled)) {
    throw new RangeError(
      `Money value for "${field}" (${major} major @ scale ${scale}) is outside the safe integer range; refusing to convert.`,
    );
  }
  return BigInt(scaled);
}
