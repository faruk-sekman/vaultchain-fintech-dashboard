/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect } from 'vitest';
import { PasswordRulesComponent } from './password-rules.component';

/** The component has no injected deps; instantiate directly and read its protected computeds. */
function make(password: string) {
  const c = new PasswordRulesComponent();
  (c as unknown as { password: string }).password = password;
  return c as unknown as {
    evaluation: () => { score: number; results: unknown[] };
    labelKey: () => string;
    color: () => string;
  };
}

describe('PasswordRulesComponent', () => {
  it('empty password → score 0, faint colour, no rules met', () => {
    const c = make('');
    expect(c.evaluation().score).toBe(0);
    expect(c.color()).toBe('var(--ld-faint)');
  });

  it('length-only password → weak (score 1, red)', () => {
    const c = make('aaaaaaaaaaaa'); // 12 chars: only len + lower
    expect(c.evaluation().score).toBe(1);
    expect(c.color()).toBe('#dc2b32');
  });

  it('all five rules → very strong (score 4, deep green) with the right label', () => {
    const c = make('Passw0rd!abc'); // 12 chars: upper, lower, digit, symbol, len
    expect(c.evaluation().score).toBe(4);
    expect(c.labelKey()).toBe('auth.forgot.strength.veryStrong');
    expect(c.color()).toBe('#16864a');
  });

  it('always exposes the five rule rows', () => {
    expect(make('').evaluation().results.length).toBe(5);
  });

  it('coerces a null/undefined password input to "" (the setter ?? "" branch)', () => {
    // The Input setter guards null/undefined → empty string, so score stays 0 (no crash).
    const c = make(null as unknown as string);
    expect(c.evaluation().score).toBe(0);
    expect(c.color()).toBe('var(--ld-faint)');

    const u = make(undefined as unknown as string);
    expect(u.evaluation().score).toBe(0);
  });
});
