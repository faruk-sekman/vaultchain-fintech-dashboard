/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { maskAddress, maskEmail, maskName, maskPhone, maskWalletNumber } from './mask';

describe('maskEmail', () => {
  it('keeps only first local char, first domain char, and TLD', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@e***.com');
    expect(maskEmail('c64@example.com')).toBe('c***@e***.com');
  });

  it('never returns the raw local part or full domain', () => {
    const masked = maskEmail('alice@bank.co.uk');
    expect(masked).not.toContain('alice');
    expect(masked).not.toContain('bank.co');
    expect(masked).toContain('***');
  });

  it('returns *** for missing or malformed input', () => {
    expect(maskEmail(null)).toBe('***');
    expect(maskEmail(undefined)).toBe('***');
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@nolocal.com')).toBe('***');
    expect(maskEmail('trailing@')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('reveals only the last four digits', () => {
    expect(maskPhone('+90 532 123 4567')).toBe('*** *** 4567');
    expect(maskPhone('5321234567')).toBe('*** *** 4567');
  });

  it('returns null when absent and *** when too short to reveal four digits', () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone('12')).toBe('***');
  });
});

describe('maskName', () => {
  it('keeps the first name and reduces the rest to initials', () => {
    expect(maskName('Ada Lovelace')).toBe('Ada L***');
    expect(maskName('Grace Brewster Hopper')).toBe('Grace B*** H***');
  });

  it('handles a single token and never returns the full surname', () => {
    expect(maskName('Cher')).toBe('C***');
    expect(maskName('Ada Lovelace')).not.toContain('Lovelace');
  });

  it('returns *** for missing/empty input', () => {
    expect(maskName(null)).toBe('***');
    expect(maskName(undefined)).toBe('***');
    expect(maskName('   ')).toBe('***');
  });
});

describe('maskWalletNumber', () => {
  it('reveals only the last four characters', () => {
    expect(maskWalletNumber('1234567890123456')).toBe('************3456');
  });

  it('returns null when absent and *** when too short', () => {
    expect(maskWalletNumber(null)).toBeNull();
    expect(maskWalletNumber(undefined)).toBeNull();
    expect(maskWalletNumber('12')).toBe('***');
  });
});

describe('maskAddress', () => {
  it('reduces a street line to a single hint character', () => {
    expect(maskAddress('Main Street 12')).toBe('M***');
    expect(maskAddress('123 Main St')).toBe('1***');
  });

  it('never returns the full street/number', () => {
    const masked = maskAddress('42 Wallaby Way, Sydney');
    expect(masked).not.toContain('Wallaby');
    expect(masked).toContain('***');
  });

  it('returns null when absent and *** when blank', () => {
    expect(maskAddress(null)).toBeNull();
    expect(maskAddress(undefined)).toBeNull();
    expect(maskAddress('   ')).toBe('***');
  });
});
