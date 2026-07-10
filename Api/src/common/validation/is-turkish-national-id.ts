/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Server-side Turkish national ID (TC Kimlik No) validator. It mirrors the
 * frontend `turkishNationalIdValidator` EXACTLY so a value that passes the form also passes the
 * API (a divergence would let the form submit a value the API then rejects with a 400).
 *
 * Rules: 11 digits, first digit ≠ 0, plus the two official checksum digits —
 *   digit10 = ((Σ odd-position[1,3,5,7,9] × 7 − Σ even-position[2,4,6,8]) mod 10), normalized non-negative
 *   digit11 = (Σ of the first ten digits) mod 10
 * Pure arithmetic, no crypto.
 */
import { registerDecorator, ValidationOptions } from 'class-validator';

export function isTurkishNationalId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!/^\d{11}$/.test(raw)) return false;
  if (raw.startsWith('0')) return false;

  const d = raw.split('').map(Number);
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const digit10 = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  if (digit10 !== d[9]) return false;

  const firstTenSum = d.slice(0, 10).reduce((sum, n) => sum + n, 0);
  return firstTenSum % 10 === d[10];
}

/** class-validator decorator wrapping {@link isTurkishNationalId}. */
export function IsTurkishNationalId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isTurkishNationalId',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown): boolean => isTurkishNationalId(value),
        defaultMessage: (): string => 'nationalId must be a valid Turkish national ID (TC Kimlik No).',
      },
    });
  };
}
