/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch/function-completion tests for the TC Kimlik No validator. The sibling spec
 * covers the bare isTurkishNationalId() predicate; this file exercises the IsTurkishNationalId()
 * class-validator DECORATOR end-to-end (validate() pass/fail + the defaultMessage), which is the
 * uncovered function, plus the digit10 non-negative-normalization checksum branch.
 */
import { validate } from 'class-validator';
import { IsTurkishNationalId, isTurkishNationalId } from './is-turkish-national-id';

class Dto {
  @IsTurkishNationalId()
  nationalId!: unknown;

  constructor(nationalId: unknown) {
    this.nationalId = nationalId;
  }
}

describe('IsTurkishNationalId decorator — function completion', () => {
  it('passes validation for a checksum-valid id (no constraint errors)', async () => {
    const errors = await validate(new Dto('10000000146'));
    expect(errors).toHaveLength(0);
  });

  it('fails validation and exposes the isTurkishNationalId constraint + default message', async () => {
    const errors = await validate(new Dto('12345678901'));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isTurkishNationalId');
    expect(errors[0].constraints?.isTurkishNationalId).toBe(
      'nationalId must be a valid Turkish national ID (TC Kimlik No).',
    );
  });

  it('fails validation for a non-string value through the decorator path', async () => {
    const errors = await validate(new Dto(10000000146));
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isTurkishNationalId');
  });
});

describe('isTurkishNationalId — checksum normalization branch', () => {
  it('accepts an id whose digit10 requires the ((x % 10) + 10) % 10 NEGATIVE normalization', () => {
    // "19090909018": oddSum(d0,d2,d4,d6,d8 = 1+0+0+0+0)=1, evenSum(d1,d3,d5,d7 = 9+9+9+9)=36,
    // raw = 1*7 - 36 = -29 (NEGATIVE). In JS -29 % 10 === -9, so the (... +10) % 10 fix → 1 = d[9].
    // firstTenSum = 28 → 28 % 10 = 8 = d[10]. Valid only because of the non-negative normalization.
    expect(isTurkishNationalId('19090909018')).toBe(true);
  });

  it('accepts a second checksum-valid id with a positive intermediate (control case)', () => {
    expect(isTurkishNationalId('19191919190')).toBe(true);
  });

  it('rejects when only the FINAL (sum-mod-10) checksum digit is wrong', () => {
    // Same digits as the control case but the last digit bumped 0 → 1 breaks only the second checksum.
    expect(isTurkishNationalId('19191919191')).toBe(false);
  });
});
