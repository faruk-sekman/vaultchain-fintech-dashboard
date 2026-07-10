/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * DTO-level validation for the customer write phone rule (A2/B7, bugfix-backlog-2026-07):
 * normalize-then-validate — separators (spaces/dashes/dots/parentheses) are stripped by the
 * @Transform, then the canonical `^(\+?\d{7,15})?$` shape is enforced, so `abc123` 400s while the
 * legacy "+90 555 123 4567" demo format stays accepted (persisted canonicalized). Blank stays the
 * documented "clear the phone" arm (`dto.phone.trim() || null` in the service).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCustomerDto, UpdateCustomerDto } from './customer-write.dto';

const BASE_CREATE = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  nationalId: '10000000146',
};

const createPhoneError = (phone: unknown) => {
  const dto = plainToInstance(CreateCustomerDto, { ...BASE_CREATE, phone });
  return validateSync(dto).find((e) => e.property === 'phone');
};

const updatePhone = (phone: unknown) => plainToInstance(UpdateCustomerDto, { rowVersion: 1, phone });
const updatePhoneError = (phone: unknown) =>
  validateSync(updatePhone(phone)).find((e) => e.property === 'phone');

describe('Customer write DTOs — phone rule (B7)', () => {
  it('accepts plain digits', () => {
    expect(createPhoneError('5551112233')).toBeUndefined();
  });

  it('accepts an international number with a leading +', () => {
    expect(createPhoneError('+905551112233')).toBeUndefined();
  });

  it('accepts and CANONICALIZES the legacy spaced demo format', () => {
    const dto = plainToInstance(CreateCustomerDto, { ...BASE_CREATE, phone: '+90 555 123 4567' });
    expect(validateSync(dto).find((e) => e.property === 'phone')).toBeUndefined();
    expect(dto.phone).toBe('+905551234567'); // separators stripped before persistence
  });

  it('rejects letters mixed into the number (abc123 → 400)', () => {
    expect(createPhoneError('abc123')?.constraints).toHaveProperty('matches');
  });

  it('rejects a number shorter than 7 digits', () => {
    expect(createPhoneError('123456')?.constraints).toHaveProperty('matches');
  });

  it('rejects a number longer than 15 digits', () => {
    expect(createPhoneError('1234567890123456')?.constraints).toHaveProperty('matches');
  });

  it('keeps the blank "clear the phone" arm working on update (whitespace → empty → valid)', () => {
    expect(updatePhoneError('   ')).toBeUndefined();
    expect(updatePhone('   ').phone).toBe('');
  });

  it('applies the same rule on update (letters → 400)', () => {
    expect(updatePhoneError('abc123')?.constraints).toHaveProperty('matches');
  });

  it('still allows the phone to be omitted entirely', () => {
    expect(createPhoneError(undefined)).toBeUndefined();
  });
});
