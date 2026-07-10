/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for AuthController (file-based ≥90% coverage round). AuthService +
 * FastifyRequest/FastifyReply are mocked; no DB/HTTP. Covers the controller's OWN branches:
 *   - login: the `outcome.status === 'mfa_required'` fork (sets ftd_mfa, NO refresh cookie, no tokens)
 *     vs the authenticated fork (sets ftd_refresh, spreads session.body).
 *   - refresh: the `!presented` UnauthorizedException guard vs the rotate-and-re-set-cookie happy path.
 *   - logout: session-only teardown — the refresh cookie is revoked/cleared while the ftd_remember
 *     device trust is left INTACT (A17, bugfix-backlog-2026-07).
 *   - me: delegation with principal.sub.
 *
 * otplib/qrcode are ESM-first; mock them so importing the AuthService chain (which transitively
 * references the MFA module) doesn't pull otplib in under Jest.
 */
jest.mock('otplib', () => ({ authenticator: {}, generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { LoginDto } from './dto/login.dto';

function makeReply() {
  return { setCookie: jest.fn(), clearCookie: jest.fn() } as unknown as FastifyReply & {
    setCookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

function makeReq(cookies: Record<string, string | undefined> = {}): FastifyRequest {
  return {
    ip: '1.2.3.4',
    headers: { 'user-agent': 'jest-ua' },
    cookies,
  } as unknown as FastifyRequest;
}

function setup() {
  const auth = { login: jest.fn(), refresh: jest.fn(), logout: jest.fn(), me: jest.fn() };
  const controller = new AuthController(auth as unknown as AuthService);
  return { auth, controller };
}

const LOGIN_DTO = { email: 'op@example.com', password: 'pw' } as LoginDto;

describe('AuthController', () => {
  describe('login', () => {
    it('authenticated outcome: sets ftd_refresh and returns the session body with status authenticated', async () => {
      const { auth, controller } = setup();
      auth.login.mockResolvedValue({
        status: 'authenticated',
        session: { refreshToken: 'refresh-tok', body: { accessToken: 'acc', expiresIn: 900 } },
      });
      const reply = makeReply();
      const req = makeReq({ ftd_remember: 'remember-tok' });

      const res = await controller.login(LOGIN_DTO, req, reply);

      expect(auth.login).toHaveBeenCalledWith('op@example.com', 'pw', {
        ip: '1.2.3.4',
        userAgent: 'jest-ua',
        rememberDeviceToken: 'remember-tok',
      });
      expect(res).toEqual({ status: 'authenticated', accessToken: 'acc', expiresIn: 900 });
      expect(reply.setCookie).toHaveBeenCalledTimes(1);
      expect(reply.setCookie).toHaveBeenCalledWith(
        'ftd_refresh',
        'refresh-tok',
        expect.objectContaining({ httpOnly: true, path: '/api/v1/auth' }),
      );
    });

    it('mfa_required outcome: sets the ftd_mfa challenge cookie, NO refresh cookie, returns only the status', async () => {
      const { auth, controller } = setup();
      auth.login.mockResolvedValue({
        status: 'mfa_required',
        challengeToken: 'chal-tok',
        challengeTtlSeconds: 300,
      });
      const reply = makeReply();

      const res = await controller.login(LOGIN_DTO, makeReq(), reply);

      expect(res).toEqual({ status: 'mfa_required' });
      expect(reply.setCookie).toHaveBeenCalledTimes(1);
      expect(reply.setCookie).toHaveBeenCalledWith(
        'ftd_mfa',
        'chal-tok',
        expect.objectContaining({ maxAge: 300, path: '/api/v1/auth' }),
      );
    });

    it('forwards an undefined rememberDeviceToken when the remember cookie is absent', async () => {
      const { auth, controller } = setup();
      auth.login.mockResolvedValue({
        status: 'authenticated',
        session: { refreshToken: 't', body: { accessToken: 'a' } },
      });
      await controller.login(LOGIN_DTO, makeReq(), makeReply());
      expect(auth.login).toHaveBeenCalledWith(
        'op@example.com',
        'pw',
        expect.objectContaining({ rememberDeviceToken: undefined }),
      );
    });
  });

  describe('refresh', () => {
    it('throws UnauthorizedException with Auth.InvalidToken when no refresh cookie is presented', async () => {
      const { auth, controller } = setup();
      const reply = makeReply();
      await expect(controller.refresh(makeReq(), reply)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller.refresh(makeReq(), reply)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'Auth.InvalidToken' }),
      });
      expect(auth.refresh).not.toHaveBeenCalled();
      expect(reply.setCookie).not.toHaveBeenCalled();
    });

    it('rotates the token, re-sets ftd_refresh, and returns the new body', async () => {
      const { auth, controller } = setup();
      auth.refresh.mockResolvedValue({ body: { accessToken: 'new-acc' }, refreshToken: 'rotated' });
      const reply = makeReply();

      const res = await controller.refresh(makeReq({ ftd_refresh: 'old-tok' }), reply);

      expect(auth.refresh).toHaveBeenCalledWith('old-tok');
      expect(res).toEqual({ accessToken: 'new-acc' });
      expect(reply.setCookie).toHaveBeenCalledWith(
        'ftd_refresh',
        'rotated',
        expect.objectContaining({ path: '/api/v1/auth' }),
      );
    });
  });

  describe('logout', () => {
    it('revokes the session, clears ONLY the refresh cookie, and leaves device trust intact (A17)', async () => {
      const { auth, controller } = setup();
      auth.logout.mockResolvedValue(undefined);
      const reply = makeReply();

      await controller.logout(makeReq({ ftd_refresh: 'r', ftd_remember: 'd' }), reply);

      expect(auth.logout).toHaveBeenCalledWith('r');
      // The remember-device cookie must SURVIVE a logout — that is the whole feature: the next
      // login on this device skips the second factor until TTL/explicit revoke.
      expect(reply.clearCookie).toHaveBeenCalledTimes(1);
      expect(reply.clearCookie).toHaveBeenCalledWith('ftd_refresh', { path: '/api/v1/auth' });
    });

    it('clears the refresh cookie but skips the revoke call when no refresh cookie is presented', async () => {
      const { auth, controller } = setup();
      const reply = makeReply();

      await controller.logout(makeReq({ ftd_remember: 'd' }), reply);

      expect(auth.logout).not.toHaveBeenCalled();
      expect(reply.clearCookie).toHaveBeenCalledTimes(1);
      expect(reply.clearCookie).toHaveBeenCalledWith('ftd_refresh', { path: '/api/v1/auth' });
    });

    it('revokes the session when only the refresh cookie is present', async () => {
      const { auth, controller } = setup();
      auth.logout.mockResolvedValue(undefined);
      await controller.logout(makeReq({ ftd_refresh: 'r' }), makeReply());
      expect(auth.logout).toHaveBeenCalledWith('r');
    });
  });

  describe('me', () => {
    it('delegates to auth.me with the principal subject', async () => {
      const { auth, controller } = setup();
      const me = { id: 'op-1', permissions: [] };
      auth.me.mockResolvedValue(me);
      const principal = { sub: 'op-1', permissions: [], permissionVersion: 0 } as AuthPrincipal;
      await expect(controller.me(principal)).resolves.toBe(me);
      expect(auth.me).toHaveBeenCalledWith('op-1');
    });
  });
});
