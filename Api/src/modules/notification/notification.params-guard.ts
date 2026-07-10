/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * paramsJson forbidden-field guard (security). A notification's `paramsJson` carries only
 * SMALL, non-sensitive interpolation values the FE substitutes into a titleKey/bodyKey (e.g. a count, a
 * masked last-4, a city). It must NEVER carry raw PII or a secret. This guard is enforced at the EMIT
 * layer (NotificationService.emit) so a bad params object is rejected BEFORE a row is written and BEFORE
 * the SSE event fans out — fail-closed.
 *
 * The check is deny-by-pattern on the KEY NAMES (case-insensitive, substring) so a renamed variant
 * (`customerEmail`, `national_id`, `ipAddress`, `accessToken`) is still caught. In addition, every string
 * VALUE is scanned for a small set of HIGH-CONFIDENCE PII/secret shapes (email, JWT, long opaque token,
 * raw IPv4) so a caller cannot smuggle sensitive data through a benign-looking key. Nested objects/arrays
 * are walked recursively. This is a guard rail, not a substitute for callers passing clean params.
 *
 * The value scan is deliberately CONSERVATIVE — it must never reject the legitimate coarse params real
 * emits use (counts, masked last-4, short city/status labels, i18n keys, UUID resource ids). UUIDs are
 * explicitly exempt from the opaque-token rule, and the rules only fire on very specific shapes.
 */
import { BadRequestException } from '@nestjs/common';

/**
 * Substrings that may NOT appear in any params key (case-insensitive). Covers the PII/secret classes the
 * net-backlog calls out (national_id / email / ip / token) plus the obvious neighbours (password, secret,
 * ssn, phone, address, dob, pan/card, cvv, auth/bearer/cookie/session credentials).
 */
const FORBIDDEN_KEY_SUBSTRINGS: readonly string[] = [
  'national_id',
  'nationalid',
  'ssn',
  'email',
  'phone',
  'address',
  'dob',
  'dateofbirth',
  'birth',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'cookie',
  'session',
  'ip',
  'ipaddress',
  'ip_address',
  'pan',
  'cardnumber',
  'card_number',
  'cvv',
  'iban',
];

/** Max serialized size of paramsJson — params are interpolation values, not a payload dump. */
const MAX_PARAMS_BYTES = 2_048;

/**
 * A canonical UUID (any version), case-insensitive. Exempt from the opaque-token rule below: resource ids
 * like `customerId`/`resourceId` are legitimate 36-char values and must NOT trip the secret heuristic.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HIGH-CONFIDENCE PII/secret VALUE shapes. Each is intentionally narrow to avoid false-positives on coarse
 * interpolation values (counts, masked last-4, short city/status labels, i18n keys, UUIDs):
 *  - email   : an RFC-ish local@domain.tld address.
 *  - jwt     : a JWS compact token — base64url header starting `eyJ`, then two more dot-separated segments.
 *  - ipv4    : a dotted-quad with each octet 0–255 (rejects "1.2.3.4" but not "v1.2.3" or "10").
 *  - token   : a single opaque run of ≥32 base64/hex/url-safe chars (no spaces) — a key/secret/hash. UUIDs
 *              are excluded by an explicit guard; short labels never reach this length.
 */
const VALUE_PATTERNS: ReadonlyArray<{ readonly id: string; readonly re: RegExp }> = [
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/ },
  {
    id: 'ipv4',
    re: /\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b/,
  },
  { id: 'token', re: /^[A-Za-z0-9+/=_-]{32,}$/ },
];

/**
 * Returns the id of the first VALUE pattern a string matches, or null. Trims first so trailing/leading
 * whitespace doesn't defeat the anchored opaque-token rule. UUIDs are exempted from `token`.
 */
function forbiddenValuePattern(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  for (const { id, re } of VALUE_PATTERNS) {
    if (id === 'token' && UUID_RE.test(v)) continue; // resource ids are legit
    if (re.test(v)) return id;
  }
  return null;
}

function keyIsForbidden(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, ''); // normalize: drop separators so ip_address≈ipaddress
  const raw = key.toLowerCase();
  return FORBIDDEN_KEY_SUBSTRINGS.some((bad) => {
    const b = bad.replace(/[^a-z0-9]/g, '');
    // 'ip' is short and would false-positive inside words (e.g. "description", "tip"); for the 2-char
    // tokens require a whole-segment match on the raw key, not a substring.
    if (b === 'ip' || b === 'pan' || b === 'dob' || b === 'ssn' || b === 'cvv' || b === 'iban') {
      return raw === bad || raw.split(/[^a-z0-9]/).includes(bad) || k === b;
    }
    return k.includes(b);
  });
}

function walk(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const hit = forbiddenValuePattern(value);
    if (hit) {
      throw new BadRequestException({
        code: 'Notification.ForbiddenParam',
        message: `paramsJson value at "${path || '(root)'}" looks like ${hit} data (PII/secret are forbidden in notification params).`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (keyIsForbidden(key)) {
        throw new BadRequestException({
          code: 'Notification.ForbiddenParam',
          message: `paramsJson may not contain a "${key}" field (PII/secret are forbidden in notification params).`,
        });
      }
      walk(v, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Assert a params object is safe to persist/emit. Throws `Notification.ForbiddenParam` (400) on any
 * forbidden key OR any string value matching a high-confidence PII/secret shape (email, JWT, opaque token,
 * IPv4), or `Notification.ParamsTooLarge` (400) if it exceeds the size budget. A null/undefined params is
 * fine (no params).
 */
export function assertSafeNotificationParams(params: Record<string, unknown> | null | undefined): void {
  if (params === null || params === undefined) return;
  const serialized = JSON.stringify(params);
  if (serialized.length > MAX_PARAMS_BYTES) {
    throw new BadRequestException({
      code: 'Notification.ParamsTooLarge',
      message: `paramsJson exceeds the ${MAX_PARAMS_BYTES}-byte budget.`,
    });
  }
  walk(params, '');
}
