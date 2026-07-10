/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect } from 'vitest';
import { FormControl, FormGroup } from '@angular/forms';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  evaluatePassword,
  passwordPolicyValidator,
  passwordsMatch,
} from './password-policy';

// All-5-rule compliant samples are 12+ chars to match the backend reset policy (min 12).
const COMPLIANT = 'Passw0rd!abc'; // 12 chars: upper, lower, digit, symbol, len

describe('password-policy', () => {
  it('pins the minimum length to the backend reset floor (12)', () => {
    expect(PASSWORD_MIN).toBe(12);
  });

  describe('evaluatePassword', () => {
    it('scores an empty password as 0 with nothing met', () => {
      const e = evaluatePassword('');
      expect(e.score).toBe(0);
      expect(e.met).toBe(0);
      expect(e.allMet).toBe(false);
    });

    it('rates a length-only password weak (score 1)', () => {
      const e = evaluatePassword('aaaaaaaaaaaa'); // 12 chars: len + lower = 2 rules
      expect(e.met).toBe(2);
      expect(e.score).toBe(1);
      expect(e.allMet).toBe(false);
    });

    it('counts the length rule only at 12+ characters (an 11-char all-class password misses len)', () => {
      const e = evaluatePassword('Aa1!aaaaaaa'); // 11 chars: upper, lower, digit, symbol — but NOT len
      expect(e.met).toBe(4);
      expect(e.allMet).toBe(false);
    });

    it('rates exactly three rules as fair (score 2)', () => {
      // 'Aaaaaaaaaaaa' (12 chars): len + upper + lower = 3 rules → score 2 (the met===3 branch).
      const e = evaluatePassword('Aaaaaaaaaaaa');
      expect(e.met).toBe(3);
      expect(e.score).toBe(2);
      expect(e.allMet).toBe(false);
    });

    it('rates four rules as strong (score 3)', () => {
      const e = evaluatePassword('Aaaaaaaaaaa1'); // 12 chars: len, upper, lower, digit = 4
      expect(e.met).toBe(4);
      expect(e.score).toBe(3);
      expect(e.allMet).toBe(false);
    });

    it('rates all five rules as very strong (score 4) and allMet at 12+ chars', () => {
      const e = evaluatePassword(COMPLIANT);
      expect(e.met).toBe(5);
      expect(e.score).toBe(4);
      expect(e.allMet).toBe(true);
    });

    it('fails allMet when over the max length even if all rules pass', () => {
      const long = 'A1!' + 'a'.repeat(PASSWORD_MAX);
      expect(evaluatePassword(long).allMet).toBe(false);
    });
  });

  describe('passwordPolicyValidator', () => {
    it('returns required for empty', () => {
      expect(passwordPolicyValidator(new FormControl(''))).toEqual({ required: true });
    });

    it('returns policy error for a weak password', () => {
      expect(passwordPolicyValidator(new FormControl('lowercase1'))).toEqual({ policy: true });
    });

    it('returns policy error for an otherwise-strong password under 12 chars', () => {
      // 'Passw0rd!' is 9 chars: all character classes pass but the length rule fails (server would 400).
      expect(passwordPolicyValidator(new FormControl('Passw0rd!'))).toEqual({ policy: true });
    });

    it('returns null for a compliant 12+ char password', () => {
      expect(passwordPolicyValidator(new FormControl(COMPLIANT))).toBeNull();
    });

    it('treats a null control value as empty → required (the value ?? "" branch)', () => {
      expect(passwordPolicyValidator(new FormControl(null))).toEqual({ required: true });
    });
  });

  describe('passwordsMatch', () => {
    const group = (password: string, confirm: string) =>
      new FormGroup({ password: new FormControl(password), confirm: new FormControl(confirm) });

    it('is null while either field is empty (confirm empty, then password empty)', () => {
      // password set, confirm empty → the `confirm &&` short-circuit returns null.
      expect(passwordsMatch(group('Passw0rd!', ''))).toBeNull();
      // password empty, confirm set → the leading `password &&` short-circuit returns null.
      expect(passwordsMatch(group('', 'Passw0rd!'))).toBeNull();
    });

    it('flags a mismatch', () => {
      expect(passwordsMatch(group('Passw0rd!', 'Other1!a'))).toEqual({ mismatch: true });
    });

    it('passes when equal', () => {
      expect(passwordsMatch(group('Passw0rd!', 'Passw0rd!'))).toBeNull();
    });
  });
});
