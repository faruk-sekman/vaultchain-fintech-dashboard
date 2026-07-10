/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetController (verify split into verify-code + verify)
 * — PasswordResetService + FastifyReply mocked. Covers: initiate ALWAYS returns
 * 202-shaped { status: 'reset_initiated' } and sets the ftd_pwreset cookie ONLY when the service returns
 * a token; verify-code returns { status: 'code_verified' } and changes NO cookie; verify returns
 * { status: 'reset_complete' } with ONLY the password forwarded, clears the cookie, sets NO session cookie.
 */
// otplib/qrcode are ESM-first; mock them so importing the service chain doesn't load otplib under Jest.
jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import type { FastifyReply, FastifyRequest } from 'fastify';
import { PasswordResetController } from './password-reset.controller';
import type { OpenResetChallenge } from './password-reset-challenge.service';
import type { PasswordResetService } from './password-reset.service';

function makeReply() {
  return { setCookie: jest.fn(), clearCookie: jest.fn() } as unknown as FastifyReply & {
    setCookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

const REQ = { ip: '1.2.3.4', headers: { 'user-agent': 'ua' } } as unknown as FastifyRequest;
const CHALLENGE: OpenResetChallenge = {
  id: 'c1',
  userId: 'u1',
  purpose: 'PASSWORD_RESET',
  attemptCount: 0,
  maxAttempts: 5,
  createdIpHash: null,
  uaHash: null,
  factorVerifiedAt: null,
  factorMethod: null,
};

describe('PasswordResetController', () => {
  it('#1 initiate sets the ftd_pwreset cookie when the service returns a token (eligible account)', async () => {
    const service = {
      initiate: jest.fn().mockResolvedValue({ challengeToken: 'pwr_id.secret', challengeTtlSeconds: 300 }),
    } as unknown as PasswordResetService;
    const ctrl = new PasswordResetController(service);
    const reply = makeReply();
    const res = await ctrl.initiate({ email: 'op@example.com' }, REQ, reply);
    expect(res).toEqual({ status: 'reset_initiated' });
    expect(reply.setCookie).toHaveBeenCalledWith('ftd_pwreset', 'pwr_id.secret', expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth', maxAge: 300 }));
  });

  it('#2 initiate sets the cookie even for an ineligible account (decoy token) — Set-Cookie uniform', async () => {
    const service = {
      initiate: jest.fn().mockResolvedValue({ challengeToken: 'pwr_decoy.secret', challengeTtlSeconds: 300 }),
    } as unknown as PasswordResetService;
    const ctrl = new PasswordResetController(service);
    const reply = makeReply();
    const res = await ctrl.initiate({ email: 'ghost@example.com' }, REQ, reply);
    expect(res).toEqual({ status: 'reset_initiated' });
    // The header is present for every account state — only the (opaque) token value differs.
    expect(reply.setCookie).toHaveBeenCalledWith('ftd_pwreset', 'pwr_decoy.secret', expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth' }));
  });

  it('#3 verify-code forwards the code, returns code_verified, and changes NO cookie', async () => {
    const service = {
      verifyCode: jest.fn().mockResolvedValue({ status: 'code_verified' }),
    } as unknown as PasswordResetService;
    const ctrl = new PasswordResetController(service);
    const res = await ctrl.verifyCode(CHALLENGE, { code: '123456' }, REQ);
    expect(res).toEqual({ status: 'code_verified' });
    expect(service.verifyCode).toHaveBeenCalledWith(CHALLENGE, '123456', { ip: '1.2.3.4', userAgent: 'ua' });
  });

  it('#4 verify forwards ONLY the password (no code), clears the cookie, sets NO session cookie, returns reset_complete', async () => {
    const service = { verify: jest.fn().mockResolvedValue(undefined) } as unknown as PasswordResetService;
    const ctrl = new PasswordResetController(service);
    const reply = makeReply();
    const res = await ctrl.verify(CHALLENGE, { newPassword: 'Aa1!aaaaaaaa' }, REQ, reply);
    expect(res).toEqual({ status: 'reset_complete' });
    expect(service.verify).toHaveBeenCalledWith(CHALLENGE, 'Aa1!aaaaaaaa', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(reply.clearCookie).toHaveBeenCalledWith('ftd_pwreset', { path: '/api/v1/auth' });
    expect(reply.setCookie).not.toHaveBeenCalled(); // no auto-login
  });
});
