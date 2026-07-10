/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpContext } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { ApiClientService } from './api-client.service';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import { MfaApi } from './mfa.api';

const AUTHED = {
  data: {
    status: 'authenticated',
    accessToken: 'tok',
    tokenType: 'Bearer',
    expiresIn: 900,
    permissions: [],
    user: { id: 'u1', displayName: 'Op', email: 'o***@e***.com', mfaEnabled: true },
  },
};

/** The login-flow verify calls must opt into the httpOnly ftd_mfa cookie. */
const WITH_COOKIE = { withCredentials: true };

describe('MfaApi', () => {
  let api: {
    post: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mfa: MfaApi;

  beforeEach(() => {
    api = {
      post: vi.fn(() => of(AUTHED)),
      get: vi.fn(() => of({ data: [] })),
      delete: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      providers: [MfaApi, { provide: ApiClientService, useValue: api }],
    });
    mfa = TestBed.inject(MfaApi);
  });

  it('verify() hits /auth/mfa/verify with the code + rememberDevice, withCredentials', async () => {
    const res = await lastValueFrom(mfa.verify('123456', true));
    expect(api.post).toHaveBeenCalledWith(
      '/auth/mfa/verify',
      { code: '123456', rememberDevice: true },
      WITH_COOKIE,
    );
    expect(res.status).toBe('authenticated');
    expect(res.accessToken).toBe('tok');
  });

  it('verify() defaults rememberDevice to false when omitted (default OFF, AC4)', async () => {
    await lastValueFrom(mfa.verify('123456'));
    expect(api.post).toHaveBeenCalledWith(
      '/auth/mfa/verify',
      { code: '123456', rememberDevice: false },
      WITH_COOKIE,
    );
  });

  it('verifyBackupCode() hits /auth/mfa/backup-code/verify with the code, withCredentials', async () => {
    await lastValueFrom(mfa.verifyBackupCode('AAAAA-BBBBB'));
    expect(api.post).toHaveBeenCalledWith(
      '/auth/mfa/backup-code/verify',
      { code: 'AAAAA-BBBBB' },
      WITH_COOKIE,
    );
  });

  it('setupStart() posts the password (Bearer-flow, no cookie opt-in) and unwraps the data', async () => {
    api.post.mockReturnValueOnce(
      of({ data: { otpauthUri: 'otpauth://x', qrDataUrl: 'data:image/png;base64,x' } }),
    );
    const res = await lastValueFrom(mfa.setupStart('Test-Passw0rd!'));
    expect(api.post).toHaveBeenCalledWith('/auth/mfa/setup/start', { password: 'Test-Passw0rd!' });
    expect(res.qrDataUrl).toContain('data:image');
  });

  it('setupConfirm() posts the code and returns the one-time backup codes', async () => {
    api.post.mockReturnValueOnce(of({ data: { backupCodes: ['AAAA-AAAA', 'BBBB-BBBB'] } }));
    const res = await lastValueFrom(mfa.setupConfirm('123456'));
    expect(api.post).toHaveBeenCalledWith('/auth/mfa/setup/confirm', { code: '123456' });
    expect(res.backupCodes).toHaveLength(2);
  });

  it('disable() posts password + code and resolves void on the 204', async () => {
    api.post.mockReturnValueOnce(of(undefined));
    const res = await lastValueFrom(mfa.disable('Test-Passw0rd!', '123456'));
    expect(api.post).toHaveBeenCalledWith('/auth/mfa/disable', {
      password: 'Test-Passw0rd!',
      code: '123456',
    });
    expect(res).toBeUndefined();
  });

  it('regenerateBackupCodes() posts password + code and returns the fresh codes', async () => {
    api.post.mockReturnValueOnce(of({ data: { backupCodes: ['CCCC-CCCC'] } }));
    const res = await lastValueFrom(mfa.regenerateBackupCodes('Test-Passw0rd!', '123456'));
    expect(api.post).toHaveBeenCalledWith('/auth/mfa/backup-codes/regenerate', {
      password: 'Test-Passw0rd!',
      code: '123456',
    });
    expect(res.backupCodes).toEqual(['CCCC-CCCC']);
  });

  // --- Trusted devices ---

  it('listTrustedDevices() GETs /auth/mfa/devices and unwraps the data array', async () => {
    const devices = [
      {
        id: 'dev-1',
        createdAt: '2026-06-01T10:00:00.000Z',
        expiresAt: '2026-07-01T10:00:00.000Z',
        ipPrefix: '203.0.113.0/24',
      },
    ];
    api.get.mockReturnValueOnce(of({ data: devices }));
    const res = await lastValueFrom(mfa.listTrustedDevices());
    expect(api.get).toHaveBeenCalledWith('/auth/mfa/devices');
    expect(res).toEqual(devices);
  });

  it('listTrustedDevices() returns an empty list when the feature is off (no devices)', async () => {
    api.get.mockReturnValueOnce(of({ data: [] }));
    const res = await lastValueFrom(mfa.listTrustedDevices());
    expect(res).toEqual([]);
  });

  it('revokeTrustedDevice() DELETEs /auth/mfa/devices/:id and resolves void on the 204', async () => {
    api.delete.mockReturnValueOnce(of(undefined));
    const res = await lastValueFrom(mfa.revokeTrustedDevice('dev-1'));
    expect(api.delete).toHaveBeenCalledWith('/auth/mfa/devices/dev-1');
    expect(res).toBeUndefined();
  });

  it('revokeTrustedDevice() propagates a delete error (e.g. 404 already-revoked) to the caller', async () => {
    api.delete.mockReturnValueOnce(throwError(() => ({ status: 404 })));
    await expect(lastValueFrom(mfa.revokeTrustedDevice('gone'))).rejects.toMatchObject({
      status: 404,
    });
  });

  // --- Administrator MFA reset ---

  it('adminReset() POSTs /auth/mfa/admin-reset with EXACTLY { userId }, SILENT_REQUEST, no cookie; resolves void on the 204', async () => {
    api.post.mockReturnValueOnce(of(undefined));
    const res = await lastValueFrom(mfa.adminReset('11111111-1111-1111-1111-111111111111'));
    // The body field name is `userId` (NOT targetUserId) and carries no extra fields — the BE DTO
    // rejects any unknown field under forbidNonWhitelisted with a 400.
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body, opts] = api.post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { withCredentials?: boolean; context?: HttpContext },
    ];
    expect(path).toBe('/auth/mfa/admin-reset');
    expect(body).toEqual({ userId: '11111111-1111-1111-1111-111111111111' });
    // Bearer-flow: NO cookie opt-in.
    expect(opts.withCredentials).toBeUndefined();
    // SILENT_REQUEST is set so the screen owns the single inline message (no duplicate global toast).
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
    expect(res).toBeUndefined();
  });

  it('adminReset() propagates an error (e.g. 403 self-reset) to the caller for inline mapping', async () => {
    api.post.mockReturnValueOnce(throwError(() => ({ status: 403 })));
    await expect(
      lastValueFrom(mfa.adminReset('22222222-2222-2222-2222-222222222222')),
    ).rejects.toMatchObject({ status: 403 });
  });
});
