/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the paramsJson forbidden-field guard. Pins that the emit layer rejects
 * PII/secret KEYS (national_id / email / ip / token / password / ...) AND high-confidence PII/secret VALUES
 * (email / JWT / opaque token / IPv4), at any nesting depth, while allowing benign interpolation values
 * (counts, masked last-4, city, status labels, UUID ids). Also pins the size budget.
 */
import { BadRequestException } from '@nestjs/common';
import { assertSafeNotificationParams } from './notification.params-guard';

describe('assertSafeNotificationParams', () => {
  it('allows null / undefined params', () => {
    expect(() => assertSafeNotificationParams(null)).not.toThrow();
    expect(() => assertSafeNotificationParams(undefined)).not.toThrow();
  });

  it('allows benign interpolation values', () => {
    expect(() =>
      assertSafeNotificationParams({ count: 3, last4: '1234', city: 'Ankara', customerId: 'c1', from: 'PENDING', to: 'VERIFIED' }),
    ).not.toThrow();
  });

  it('allows a UUID resourceId value (must NOT trip the opaque-token rule)', () => {
    // Mirrors the real KYC emit: { customerId: <uuid>, from, to }. A 36-char UUID is base64/hex-shaped but
    // is an exempt resource id, not a secret.
    expect(() =>
      assertSafeNotificationParams({ customerId: '018f5b3a-7c2e-7e1a-9b44-2f6c1d8e0a55', from: 'PENDING', to: 'REJECTED' }),
    ).not.toThrow();
  });

  it.each([
    ['email value (benign key)', { label: 'reach me at john.doe@example.com please' }],
    ['JWT value', { ref: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dummysig' }],
    ['long opaque token value', { ref: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0' }],
    ['raw IPv4 value', { note: 'seen from 192.168.10.254 today' }],
  ])('rejects a high-confidence PII/secret VALUE: %s', (_label, params) => {
    expect(() => assertSafeNotificationParams(params)).toThrow(BadRequestException);
  });

  it('rejects a forbidden VALUE nested inside an object', () => {
    expect(() => assertSafeNotificationParams({ outer: { inner: { note: 'x@y.com' } } })).toThrow(BadRequestException);
  });

  it('rejects a forbidden VALUE inside an array element', () => {
    expect(() => assertSafeNotificationParams({ list: ['ok', '10.0.0.1'] })).toThrow(BadRequestException);
  });

  it('does NOT false-positive on short labels, counts, versions, or i18n keys (value scan)', () => {
    expect(() =>
      assertSafeNotificationParams({
        title: 'notifications.kyc.statusChanged.title',
        version: 'v1.2',
        amount: '1234.56',
        ratio: '3.14',
        shortHex: 'deadbeef',
      }),
    ).not.toThrow();
  });

  it.each([
    ['national_id', { national_id: '12345678901' }],
    ['nationalId', { nationalId: '12345678901' }],
    ['email', { email: 'a@b.com' }],
    ['customerEmail', { customerEmail: 'a@b.com' }],
    ['phone', { phone: '5550000' }],
    ['password', { password: 'hunter2' }],
    ['secret', { totpSecret: 'JBSWY3DP' }],
    ['token', { accessToken: 'ey...' }],
    ['authorization', { authorization: 'Bearer x' }],
    ['address', { addressLine1: '1 Main St' }],
    ['ssn', { ssn: '111-22-3333' }],
    ['ipAddress', { ipAddress: '10.0.0.1' }],
    ['ip (whole segment)', { ip: '10.0.0.1' }],
    ['cardNumber', { cardNumber: '4111111111111111' }],
    ['iban', { iban: 'TR00' }],
  ])('rejects a forbidden key: %s', (_label, params) => {
    expect(() => assertSafeNotificationParams(params)).toThrow(BadRequestException);
  });

  it('rejects a forbidden key NESTED inside an object', () => {
    expect(() => assertSafeNotificationParams({ outer: { inner: { email: 'a@b.com' } } })).toThrow(BadRequestException);
  });

  it('rejects a forbidden key nested inside an array of objects', () => {
    expect(() => assertSafeNotificationParams({ list: [{ ok: 1 }, { token: 'x' }] })).toThrow(BadRequestException);
  });

  it('does NOT false-positive on benign words containing a short token (description, tip)', () => {
    // "description" contains "ip" as a substring — must NOT be rejected (whole-segment rule for 'ip').
    expect(() => assertSafeNotificationParams({ description: 'hello', tip: 'x', recipientCount: 2 })).not.toThrow();
  });

  it('throws Notification.ForbiddenParam with the offending field name', () => {
    try {
      assertSafeNotificationParams({ email: 'a@b.com' });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as BadRequestException;
      const body = err.getResponse() as { code: string; message: string };
      expect(body.code).toBe('Notification.ForbiddenParam');
      expect(body.message).toContain('email');
    }
  });

  it('rejects params exceeding the size budget', () => {
    const big = { blob: 'x'.repeat(3000) };
    expect(() => assertSafeNotificationParams(big)).toThrow(BadRequestException);
  });
});
