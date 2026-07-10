/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaController (file-based ≥90% coverage round). MfaLoginService +
 * FastifyRequest/FastifyReply mocked; no DB/HTTP. Covers the controller's OWN logic:
 *   - verify / verifyBackupCode forward (challenge, code, [rememberDevice], context) correctly
 *     incl. the `dto.rememberDevice ?? false` default on the TOTP path.
 *   - issueCookies sets ftd_refresh + clears the spent ftd_mfa on every path, and the
 *     `if (result.rememberDevice)` branch sets ftd_remember ONLY when present.
 *
 * otplib/qrcode are ESM-first; mock them so importing MfaLoginService -> TotpService doesn't pull
 * otplib in under Jest.
 */
jest.mock('otplib', () => ({ authenticator: {}, generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import type { FastifyReply, FastifyRequest } from 'fastify';
import { MfaController } from './mfa.controller';
import type { MfaLoginResult, MfaLoginService } from './mfa-login.service';
import type { OpenChallenge } from '../mfa/mfa-challenge.service';
import type { VerifyBackupCodeDto, VerifyTotpDto } from '../mfa/dto/mfa.dto';

function makeReply() {
  return { setCookie: jest.fn(), clearCookie: jest.fn() } as unknown as FastifyReply & {
    setCookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

const REQ = { ip: '9.9.9.9', headers: { 'user-agent': 'mfa-ua' } } as unknown as FastifyRequest;
const CHALLENGE = { id: 'chal-1', userId: 'u1' } as unknown as OpenChallenge;

function sessionResult(rememberDevice?: { token: string; ttlSeconds: number }): MfaLoginResult {
  return {
    session: { refreshToken: 'refresh-tok', body: { accessToken: 'acc', expiresIn: 900 } },
    rememberDevice,
  } as unknown as MfaLoginResult;
}

function setup() {
  const mfaLogin = { verifyTotp: jest.fn(), verifyBackupCode: jest.fn() };
  return { mfaLogin, controller: new MfaController(mfaLogin as unknown as MfaLoginService) };
}

describe('MfaController', () => {
  describe('verify (TOTP)', () => {
    it('forwards the challenge, code, rememberDevice flag and request context; sets refresh + clears challenge', async () => {
      const { mfaLogin, controller } = setup();
      mfaLogin.verifyTotp.mockResolvedValue(sessionResult());
      const dto = { code: '123456', rememberDevice: true } as VerifyTotpDto;
      const reply = makeReply();

      const res = await controller.verify(CHALLENGE, dto, REQ, reply);

      expect(mfaLogin.verifyTotp).toHaveBeenCalledWith(CHALLENGE, '123456', true, {
        ip: '9.9.9.9',
        userAgent: 'mfa-ua',
      });
      expect(res).toEqual({ status: 'authenticated', accessToken: 'acc', expiresIn: 900 });
      expect(reply.setCookie).toHaveBeenCalledWith('ftd_refresh', 'refresh-tok', expect.objectContaining({ path: '/api/v1/auth' }));
      expect(reply.clearCookie).toHaveBeenCalledWith('ftd_mfa', { path: '/api/v1/auth' });
    });

    it('defaults rememberDevice to false when the dto omits it', async () => {
      const { mfaLogin, controller } = setup();
      mfaLogin.verifyTotp.mockResolvedValue(sessionResult());
      const dto = { code: '654321' } as VerifyTotpDto;
      await controller.verify(CHALLENGE, dto, REQ, makeReply());
      expect(mfaLogin.verifyTotp).toHaveBeenCalledWith(CHALLENGE, '654321', false, expect.any(Object));
    });

    it('sets ftd_remember when the result carries a rememberDevice token', async () => {
      const { mfaLogin, controller } = setup();
      mfaLogin.verifyTotp.mockResolvedValue(sessionResult({ token: 'dev-tok', ttlSeconds: 1000 }));
      const reply = makeReply();
      await controller.verify(CHALLENGE, { code: '111111', rememberDevice: true } as VerifyTotpDto, REQ, reply);
      expect(reply.setCookie).toHaveBeenCalledWith('ftd_remember', 'dev-tok', expect.objectContaining({ maxAge: 1000, path: '/api/v1/auth' }));
    });

    it('does NOT set ftd_remember when the result has no rememberDevice', async () => {
      const { mfaLogin, controller } = setup();
      mfaLogin.verifyTotp.mockResolvedValue(sessionResult(undefined));
      const reply = makeReply();
      await controller.verify(CHALLENGE, { code: '222222' } as VerifyTotpDto, REQ, reply);
      const rememberCalls = reply.setCookie.mock.calls.filter((c) => c[0] === 'ftd_remember');
      expect(rememberCalls).toHaveLength(0);
    });
  });

  describe('verifyBackupCode', () => {
    it('forwards the challenge, code and context (no remember-device on the recovery path)', async () => {
      const { mfaLogin, controller } = setup();
      mfaLogin.verifyBackupCode.mockResolvedValue(sessionResult());
      const dto = { code: 'backup-code-1' } as VerifyBackupCodeDto;
      const reply = makeReply();

      const res = await controller.verifyBackupCode(CHALLENGE, dto, REQ, reply);

      expect(mfaLogin.verifyBackupCode).toHaveBeenCalledWith(CHALLENGE, 'backup-code-1', {
        ip: '9.9.9.9',
        userAgent: 'mfa-ua',
      });
      expect(res).toEqual({ status: 'authenticated', accessToken: 'acc', expiresIn: 900 });
      expect(reply.setCookie).toHaveBeenCalledWith('ftd_refresh', 'refresh-tok', expect.any(Object));
      expect(reply.clearCookie).toHaveBeenCalledWith('ftd_mfa', { path: '/api/v1/auth' });
    });

    it('re-throws when the service rejects (e.g. spent/invalid backup code)', async () => {
      const { mfaLogin, controller } = setup();
      const boom = new Error('invalid backup code');
      mfaLogin.verifyBackupCode.mockRejectedValue(boom);
      await expect(
        controller.verifyBackupCode(CHALLENGE, { code: 'x' } as VerifyBackupCodeDto, REQ, makeReply()),
      ).rejects.toBe(boom);
    });
  });
});
