/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Seam test for PasswordResetApi (verify split into verify-code + verify). Mocks ApiClientService
 * (the same approach as mfa.api.spec.ts) and locks the contract:
 * exact paths, request bodies (verify-code = { code }, verify = { newPassword } ONLY — no code), the
 * `withCredentials:true` cookie opt-in, the SILENT_REQUEST context flag, and `{ data }` unwrapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, lastValueFrom } from 'rxjs';
import { HttpContext } from '@angular/common/http';
import { ApiClientService } from './api-client.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import {
  PASSWORD_ADMIN_RESET_PATH,
  PASSWORD_RESET_INITIATE_PATH,
  PASSWORD_RESET_REQUEST_PATH,
  PASSWORD_RESET_REQUEST_STATUS_PATH,
  PASSWORD_RESET_REQUESTS_ADMIN_PATH,
  PASSWORD_RESET_VERIFY_CODE_PATH,
  PASSWORD_RESET_VERIFY_PATH,
  PasswordResetApi,
  ResetRequestDetail,
} from './password-reset.api';

/** A minimal admin detail row for the list/detail/decide seams (A15). */
const REQUEST_DETAIL: ResetRequestDetail = {
  id: 'req-1',
  account: { displayName: 'Audit Auditor', emailMasked: 'a***@s***.local' },
  status: 'PENDING',
  createdAt: '2026-07-01T10:00:00.000Z',
  expiresAt: '2026-07-02T10:00:00.000Z',
  decidedAt: null,
  decidedByName: null,
  completedAt: null,
  ipPrefix: '203.0.113.0/24',
  deviceSummary: 'Chrome on macOS',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

describe('PasswordResetApi', () => {
  let api: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let reset: PasswordResetApi;

  beforeEach(() => {
    api = {
      post: vi.fn(() => of({ data: { status: 'reset_initiated' } })),
      get: vi.fn(() => of({ data: [] })),
    };
    TestBed.configureTestingModule({
      providers: [PasswordResetApi, { provide: ApiClientService, useValue: api }],
    });
    reset = TestBed.inject(PasswordResetApi);
  });

  /** Pull the `opts` arg of the most recent post() call for cookie/context assertions. */
  function lastOpts(): { withCredentials?: boolean; context?: HttpContext } {
    const call = api.post.mock.calls.at(-1);
    return call?.[2] ?? {};
  }

  it('initiate() posts the email to the initiate path and unwraps { data }', async () => {
    const res = await lastValueFrom(reset.initiate('ops@example.com'));
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_INITIATE_PATH);
    expect(path).toBe('/auth/password/reset/initiate');
    expect(body).toEqual({ email: 'ops@example.com' });
    expect(res.status).toBe('reset_initiated');
  });

  it('initiate() opts into the ftd_pwreset cookie and marks the request SILENT_REQUEST', () => {
    void reset.initiate('ops@example.com').subscribe();
    const opts = lastOpts();
    expect(opts.withCredentials).toBe(true);
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('verifyCode() posts the code to the verify-code path and unwraps { data }', async () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'code_verified' } }));
    const res = await lastValueFrom(reset.verifyCode('123456'));
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_VERIFY_CODE_PATH);
    expect(path).toBe('/auth/password/reset/verify-code');
    expect(body).toEqual({ code: '123456' });
    expect(res.status).toBe('code_verified');
  });

  it('verifyCode() forwards a backup code unchanged as the `code` field', () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'code_verified' } }));
    void reset.verifyCode('ABCDE-FGHIJ').subscribe();
    const [, body] = api.post.mock.calls[0];
    expect(body).toEqual({ code: 'ABCDE-FGHIJ' });
  });

  it('verifyCode() opts into the cookie + SILENT_REQUEST (failures render inline)', () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'code_verified' } }));
    void reset.verifyCode('123456').subscribe();
    const opts = lastOpts();
    expect(opts.withCredentials).toBe(true);
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('verify() posts ONLY the newPassword to the verify path (no code — the factor is already proven)', async () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'reset_complete' } }));
    const res = await lastValueFrom(reset.verify('New-Passw0rd-12!'));
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_VERIFY_PATH);
    expect(path).toBe('/auth/password/reset/verify');
    expect(body).toEqual({ newPassword: 'New-Passw0rd-12!' });
    expect(body).not.toHaveProperty('code');
    expect(res.status).toBe('reset_complete');
  });

  it('verify() opts into the cookie + SILENT_REQUEST (failures render inline)', () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'reset_complete' } }));
    void reset.verify('New-Passw0rd-12!').subscribe();
    const opts = lastOpts();
    expect(opts.withCredentials).toBe(true);
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('uses a fresh HttpContext per call (no shared mutable token state)', () => {
    void reset.initiate('a@example.com').subscribe();
    void reset.initiate('b@example.com').subscribe();
    expect(api.post.mock.calls[0][2].context).not.toBe(api.post.mock.calls[1][2].context);
  });

  // --- adminReset ------------------------------------------------
  it('adminReset() posts EXACTLY { targetUserId, newPassword } to the admin-reset path', () => {
    api.post.mockReturnValueOnce(of(undefined));
    void reset.adminReset('11111111-1111-1111-1111-111111111111', 'New-Passw0rd-12!').subscribe();
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_ADMIN_RESET_PATH);
    expect(path).toBe('/auth/password/admin-reset');
    expect(body).toEqual({
      targetUserId: '11111111-1111-1111-1111-111111111111',
      newPassword: 'New-Passw0rd-12!',
    });
  });

  it('adminReset() marks the request SILENT_REQUEST (failures render inline on the screen)', () => {
    api.post.mockReturnValueOnce(of(undefined));
    void reset.adminReset('11111111-1111-1111-1111-111111111111', 'New-Passw0rd-12!').subscribe();
    expect(lastOpts().context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('adminReset() is Bearer-flow: it does NOT opt into the cookie (no withCredentials)', () => {
    api.post.mockReturnValueOnce(of(undefined));
    void reset.adminReset('11111111-1111-1111-1111-111111111111', 'New-Passw0rd-12!').subscribe();
    expect(lastOpts().withCredentials).toBeUndefined();
  });

  // --- admin-approval fallback (A15/A16) ------------------------------------------------
  it('createResetRequest() posts the email to the reset-request path and unwraps { data }', async () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'reset_request_received' } }));
    const res = await lastValueFrom(reset.createResetRequest('ops@example.com'));
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_REQUEST_PATH);
    expect(path).toBe('/auth/password/reset-request');
    expect(body).toEqual({ email: 'ops@example.com' });
    expect(res.status).toBe('reset_request_received');
  });

  it('createResetRequest() opts into the ftd_pwreq cookie + SILENT_REQUEST (inline failures)', () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'reset_request_received' } }));
    void reset.createResetRequest('ops@example.com').subscribe();
    const opts = lastOpts();
    expect(opts.withCredentials).toBe(true);
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('requestStatus() posts an EMPTY body to the status path (the cookie is the only handle)', async () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'approved' } }));
    const res = await lastValueFrom(reset.requestStatus());
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_REQUEST_STATUS_PATH);
    expect(path).toBe('/auth/password/reset-request/status');
    expect(body).toEqual({});
    expect(res.status).toBe('approved');
  });

  it('requestStatus() opts into the cookie + SILENT_REQUEST (the wizard polls it inline)', () => {
    api.post.mockReturnValueOnce(of({ data: { status: 'pending' } }));
    void reset.requestStatus().subscribe();
    const opts = lastOpts();
    expect(opts.withCredentials).toBe(true);
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
  });

  it('listResetRequests() GETs the admin path with NO params and unwraps the data array', async () => {
    api.get.mockReturnValueOnce(of({ data: [REQUEST_DETAIL] }));
    const res = await lastValueFrom(reset.listResetRequests());
    const [path, params] = api.get.mock.calls[0];
    expect(path).toBe(PASSWORD_RESET_REQUESTS_ADMIN_PATH);
    expect(path).toBe('/auth/password/reset-requests');
    expect(params).toBeUndefined();
    expect(res).toEqual([REQUEST_DETAIL]);
  });

  it('listResetRequests(status) forwards the lifecycle filter as a query param', () => {
    api.get.mockReturnValueOnce(of({ data: [] }));
    void reset.listResetRequests('PENDING').subscribe();
    const [, params] = api.get.mock.calls[0];
    expect(params).toEqual({ status: 'PENDING' });
  });

  it('getResetRequest() GETs the id-scoped detail path (URI-encoded) and unwraps { data }', async () => {
    api.get.mockReturnValueOnce(of({ data: REQUEST_DETAIL }));
    const res = await lastValueFrom(reset.getResetRequest('req 1'));
    const [path] = api.get.mock.calls[0];
    expect(path).toBe('/auth/password/reset-requests/req%201');
    expect(res).toEqual(REQUEST_DETAIL);
  });

  it('approveResetRequest() POSTs an empty body to :id/approve with SILENT_REQUEST, no cookie', async () => {
    api.post.mockReturnValueOnce(of({ data: { ...REQUEST_DETAIL, status: 'APPROVED' } }));
    const res = await lastValueFrom(reset.approveResetRequest('req-1'));
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe('/auth/password/reset-requests/req-1/approve');
    expect(body).toEqual({});
    expect(lastOpts().context?.get(SILENT_REQUEST)).toBe(true);
    expect(lastOpts().withCredentials).toBeUndefined(); // Bearer flow — no cookie opt-in
    expect(res.status).toBe('APPROVED');
  });

  it('denyResetRequest() POSTs an empty body to :id/deny with SILENT_REQUEST, no cookie', async () => {
    api.post.mockReturnValueOnce(of({ data: { ...REQUEST_DETAIL, status: 'DENIED' } }));
    const res = await lastValueFrom(reset.denyResetRequest('req-1'));
    const [path, body] = api.post.mock.calls[0];
    expect(path).toBe('/auth/password/reset-requests/req-1/deny');
    expect(body).toEqual({});
    expect(lastOpts().context?.get(SILENT_REQUEST)).toBe(true);
    expect(lastOpts().withCredentials).toBeUndefined();
    expect(res.status).toBe('DENIED');
  });
});
