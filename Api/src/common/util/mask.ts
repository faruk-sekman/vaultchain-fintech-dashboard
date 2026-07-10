/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * PII masking helpers for read surfaces that must not leak raw contact details
 * (e.g. the dashboard "latest customer" card). Pure functions, no I/O:
 * the leak is decided here once, then reused, and is unit-tested in mask.spec.ts.
 */

/**
 * Masks an email to `f***@e***.tld`, preserving only the first local char, the first
 * domain char, and the TLD. Returns `***` for anything that is not a usable address.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '***';
  const at = email.indexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  const domainName = dot >= 0 ? domain.slice(0, dot) : domain;
  return `${local[0]}***@${domainName[0] ?? ''}***${tld}`;
}

/**
 * Masks a phone to `*** *** 1234` (last four digits only). Returns `null` for an absent
 * number and `***` when fewer than four digits are present (nothing safe to reveal).
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `*** *** ${digits.slice(-4)}`;
}

/**
 * Masks a person's name to `Ada L***`: the first name is kept, every following name part is
 * reduced to its initial + `***`. A single token becomes `A***`. Returns `***` for empty input.
 */
export function maskName(name: string | null | undefined): string {
  if (!name) return '***';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  if (parts.length === 1) return `${parts[0][0]}***`;
  const [first, ...rest] = parts;
  return `${first} ${rest.map((p) => `${p[0]}***`).join(' ')}`;
}

/**
 * Masks an account/wallet number to its last four characters, e.g. `************3456`.
 * Returns `null` for an absent value and `***` when fewer than four characters are present.
 */
export function maskWalletNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return '***';
  const last4 = trimmed.slice(-4);
  return `${'*'.repeat(trimmed.length - 4)}${last4}`;
}

/**
 * Masks a street address line to its first character + `***`, e.g. `A***` — the exact street/number
 * is the most-identifying PII, so on masked read surfaces it is reduced to a single hint character.
 * The customer mapper additionally drops `city`/`postalCode` to `null` on masked reads and keeps
 * `country` raw (role-based reveal); only `customers.pii.reveal` holders receive raw values.
 * Returns `null` for an absent value, `***` for blank.
 */
export function maskAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return '***';
  return `${trimmed[0]}***`;
}
