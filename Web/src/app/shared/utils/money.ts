/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Money is stored as integer MINOR units (e.g. minor units / cents) end to end. Every currently-supported
 * currency (TRY/USD/EUR) is scale-2, so major = minor / 100. Centralised here so the factor is not
 * duplicated across API mappers and screens (audit D5). `minorToMajor`/`majorToMinor` accept an
 * optional per-currency `scale` (default 2) so a non-scale-2 currency converts correctly (re-audit
 * FESCALE-001); the remaining step is to thread the catalog's per-currency `scale`
 * (GET /catalog/currencies) at the API-mapper call sites once such a currency is actually added.
 *
 * Wire contract (audit O-10): money minor-unit fields cross the response boundary as a
 * JSON STRING of the exact integer minor-units (e.g. "1234500"), NOT a JS `number`. `parseMinor` is
 * the single FE deserializer — it validates the string is an integer in the safe JS range (mirroring
 * the backend `minorToSafeNumber`/`minorToWireString` contract) and fails loudly otherwise, rather
 * than letting `Number()` silently coerce a malformed or precision-losing value into display money.
 */

/** Minor-unit scale in DECIMAL DIGITS for the currently-supported currencies (TRY/USD/EUR are all 2). */
export const MINOR_UNIT_SCALE_DIGITS = 2;
/** Minor-unit multiplier for the default scale (kept for callers needing the raw factor); 10 ** digits. */
export const MINOR_UNIT_SCALE = 10 ** MINOR_UNIT_SCALE_DIGITS;

/**
 * Parse a wire money STRING of integer minor-units into a JS `number` at the API boundary.
 * Accepts an optional leading `-` and base-10 digits only; rejects empty, fractional, non-numeric,
 * and out-of-safe-range values by throwing, so malformed money fails loudly instead of rendering a
 * wrong amount. `field` names the source for the error message.
 */
export function parseMinor(value: string, field = 'amount'): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new RangeError(
      `Money value for "${field}" (${JSON.stringify(value)}) is not a base-10 integer minor-unit string.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `Money value for "${field}" (${value} minor units) exceeds the safe JS integer range; refusing to use a lossy amount.`,
    );
  }
  return parsed;
}

/**
 * Integer minor units → major units for display (e.g. 12500 → 125). `scale` is the currency's
 * minor-unit digit count (default 2 = every currently-supported currency); pass the per-currency
 * `scale` from GET /catalog/currencies for a non-scale-2 currency (re-audit FESCALE-001).
 */
export function minorToMajor(minor: number, scale = MINOR_UNIT_SCALE_DIGITS): number {
  return minor / 10 ** scale;
}

/** Major units → integer minor units for a money-moving write (e.g. 125 → 12500). `scale` as above. */
export function majorToMinor(major: number, scale = MINOR_UNIT_SCALE_DIGITS): number {
  return Math.round(major * 10 ** scale);
}
