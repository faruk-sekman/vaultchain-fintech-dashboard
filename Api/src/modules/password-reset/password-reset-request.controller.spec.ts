/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetRequestController (A15/A16) — PasswordResetRequestService + FastifyReply
 * mocked. Covers: create ALWAYS returns the neutral { status: 'reset_request_received' } AND always
 * sets the ftd_pwreq cookie (real or decoy alike, mirrored httpOnly/Strict/path options, maxAge = the
 * request TTL), forwarding the presented cookie + ip/UA; status never guards (missing cookie → service
 * gets null), maps the poll states 1:1, sets the ftd_pwreset challenge cookie ONLY on a claimed
 * approval; and the route metadata contract (@Public, 202/200, the A16 3/min + 10/min @Throttle).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../../common/auth/public.decorator';
import { PasswordResetRequestController } from './password-reset-request.controller';
import type { PasswordResetRequestService } from './password-reset-request.service';

function makeReply() {
  return { setCookie: jest.fn(), clearCookie: jest.fn() } as unknown as FastifyReply & {
    setCookie: jest.Mock;
    clearCookie: jest.Mock;
  };
}

function makeReq(cookies: Record<string, string> = {}) {
  return { ip: '1.2.3.4', headers: { 'user-agent': 'ua' }, cookies } as unknown as FastifyRequest;
}

describe('PasswordResetRequestController — create', () => {
  it('#1 forwards email + presented ftd_pwreq cookie + ip/UA and ALWAYS sets the (rotated/real) cookie', async () => {
    const service = {
      create: jest.fn().mockResolvedValue({ requestToken: 'pwq_id.secret', requestTtlSeconds: 86_400 }),
    } as unknown as PasswordResetRequestService;
    const ctrl = new PasswordResetRequestController(service);
    const reply = makeReply();

    const res = await ctrl.create({ email: 'op@example.com' }, makeReq({ ftd_pwreq: 'pwq_old.token' }), reply);

    expect(res).toEqual({ status: 'reset_request_received' });
    expect(service.create).toHaveBeenCalledWith('op@example.com', 'pwq_old.token', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(reply.setCookie).toHaveBeenCalledWith(
      'ftd_pwreq',
      'pwq_id.secret',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth', maxAge: 86_400 }),
    );
  });

  it('#2 no presented cookie → service gets null; a DECOY token still sets the header (uniform response)', async () => {
    const service = {
      create: jest.fn().mockResolvedValue({ requestToken: 'pwq_decoy.secret', requestTtlSeconds: 86_400 }),
    } as unknown as PasswordResetRequestService;
    const ctrl = new PasswordResetRequestController(service);
    const reply = makeReply();

    const res = await ctrl.create({ email: 'ghost@example.com' }, makeReq(), reply);

    expect(res).toEqual({ status: 'reset_request_received' }); // ONE neutral message for every branch (A16)
    expect(service.create).toHaveBeenCalledWith('ghost@example.com', null, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(reply.setCookie).toHaveBeenCalledWith('ftd_pwreq', 'pwq_decoy.secret', expect.objectContaining({ httpOnly: true }));
  });
});

describe('PasswordResetRequestController — status', () => {
  it('#3 forwards the cookie (null when absent) + ip/UA; a plain state sets NO cookie', async () => {
    const service = { status: jest.fn().mockResolvedValue({ status: 'pending' }) } as unknown as PasswordResetRequestService;
    const ctrl = new PasswordResetRequestController(service);
    const reply = makeReply();

    const res = await ctrl.status(makeReq(), reply);

    expect(res).toEqual({ status: 'pending' });
    expect(service.status).toHaveBeenCalledWith(null, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(reply.setCookie).not.toHaveBeenCalled();
  });

  it('#4 a claimed approval sets the ftd_pwreset challenge cookie with the challenge TTL', async () => {
    const service = {
      status: jest.fn().mockResolvedValue({ status: 'approved', challengeToken: 'pwr_ch.secret', challengeTtlSeconds: 300 }),
    } as unknown as PasswordResetRequestService;
    const ctrl = new PasswordResetRequestController(service);
    const reply = makeReply();

    const res = await ctrl.status(makeReq({ ftd_pwreq: 'pwq_id.secret' }), reply);

    expect(res).toEqual({ status: 'approved' }); // the token itself NEVER rides in the body
    expect(service.status).toHaveBeenCalledWith('pwq_id.secret', { ip: '1.2.3.4', userAgent: 'ua' });
    expect(reply.setCookie).toHaveBeenCalledWith(
      'ftd_pwreset',
      'pwr_ch.secret',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth', maxAge: 300 }),
    );
  });

  it("#5 denied/expired map straight through with no cookie change", async () => {
    const service = { status: jest.fn().mockResolvedValue({ status: 'denied' }) } as unknown as PasswordResetRequestService;
    const ctrl = new PasswordResetRequestController(service);
    const reply = makeReply();
    expect(await ctrl.status(makeReq(), reply)).toEqual({ status: 'denied' });
    expect(reply.setCookie).not.toHaveBeenCalled();
  });
});

describe('PasswordResetRequestController — route metadata (A16 contract)', () => {
  const proto = PasswordResetRequestController.prototype;

  it('#6 both endpoints are @Public (cookie-credentialed, no JWT)', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.create)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.status)).toBe(true);
  });

  it('#7 create answers 202 and is throttled 3/min/IP; status answers 200 and is throttled 10/min/IP', () => {
    // @nestjs/throttler v6 stores per-throttler metadata under THROTTLER:<FIELD><name> on the handler.
    expect(Reflect.getMetadata('__httpCode__', proto.create)).toBe(202);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.create)).toBe(3);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.create)).toBe(60_000);

    expect(Reflect.getMetadata('__httpCode__', proto.status)).toBe(200);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.status)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.status)).toBe(60_000);
  });

  it('#8 routes live under auth/password/reset-request (create at "", status at "status") as POSTs', () => {
    expect(Reflect.getMetadata('path', PasswordResetRequestController)).toBe('auth/password/reset-request');
    expect(Reflect.getMetadata('path', proto.create)).toBe('/');
    expect(Reflect.getMetadata('path', proto.status)).toBe('status');
    // RequestMethod.POST === 1 in @nestjs/common's RequestMethod enum.
    expect(Reflect.getMetadata('method', proto.create)).toBe(1);
    expect(Reflect.getMetadata('method', proto.status)).toBe(1);
  });
});
