/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * DTO-level validation for the POST /transactions amountMinor money boundary (re-audit TESTQ-002):
 * proves the @IsInt/@IsPositive/@Max guards reject 0, negative, non-integer, and > 2^53 amounts at
 * the request boundary — before the service BigInt-converts an already-lossy JS number.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TransactionKind } from '@prisma/client';
import { CreateTransactionDto } from './create-transaction.dto';

/** Validates a candidate amountMinor in an otherwise-well-formed body; returns its own error (if any). */
const amountError = (amountMinor: unknown) => {
  const dto = plainToInstance(CreateTransactionDto, {
    kind: TransactionKind.DEPOSIT,
    currency: 'USD',
    amountMinor,
  });
  return validateSync(dto).find((e) => e.property === 'amountMinor');
};

describe('CreateTransactionDto amountMinor money boundary', () => {
  it('accepts a positive safe integer', () => {
    expect(amountError(1_000)).toBeUndefined();
  });

  it('rejects an amount above Number.MAX_SAFE_INTEGER (already-lossy JS number)', () => {
    expect(amountError(Number.MAX_SAFE_INTEGER + 1)?.constraints).toHaveProperty('max');
  });

  it('rejects zero', () => {
    expect(amountError(0)?.constraints).toHaveProperty('isPositive');
  });

  it('rejects a negative amount', () => {
    expect(amountError(-1)?.constraints).toHaveProperty('isPositive');
  });

  it('rejects a non-integer amount', () => {
    expect(amountError(10.5)?.constraints).toHaveProperty('isInt');
  });
});
