/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the operator auth service. The HTTP collaborators
 * (ApiClientService, MfaApi) are mocked, so these pin the security-critical behaviour without a
 * network: in-memory token only, the fail-closed completion guard, the opt-in MFA gate, refresh
 * single-flight + session clear on failure, and synchronous sign-out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ApiClientService } from '@core/api/api-client.service';
import { MfaApi } from '@core/api/mfa.api';
import { PasswordResetApi } from '@core/api/password-reset.api';
import { AuthService } from './auth.service';
import type { AuthenticatedResponse, Principal } from './auth.model';

const authResp = (over: Partial<AuthenticatedResponse> = {}): AuthenticatedResponse => ({
  status: 'authenticated',
  accessToken: 'tok-123',
  tokenType: 'Bearer',
  expiresIn: 900,
  permissions: ['customers.read'],
  user: { id: 'u1', displayName: 'Admin', email: 'a***@e***.com', mfaEnabled: false },
  ...over,
});

const principal: Principal = {
  user: { id: 'u1', displayName: 'Admin', email: 'a***@e***.com', mfaEnabled: true },
  permissions: ['customers.read', 'customers.write'],
};

describe('AuthService', () => {
  let api: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let mfa: {
    verify: ReturnType<typeof vi.fn>;
    verifyBackupCode: ReturnType<typeof vi.fn>;
    setupStart: ReturnType<typeof vi.fn>;
    setupConfirm: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
    regenerateBackupCodes: ReturnType<typeof vi.fn>;
    listTrustedDevices: ReturnType<typeof vi.fn>;
    revokeTrustedDevice: ReturnType<typeof vi.fn>;
    adminReset: ReturnType<typeof vi.fn>;
  };
  let passwordReset: { adminReset: ReturnType<typeof vi.fn> };
  let service: AuthService;

  beforeEach(() => {
    localStorage.clear();
    api = { post: vi.fn(), get: vi.fn() };
    mfa = {
      verify: vi.fn(),
      verifyBackupCode: vi.fn(),
      setupStart: vi.fn(),
      setupConfirm: vi.fn(),
      disable: vi.fn(),
      regenerateBackupCodes: vi.fn(),
      listTrustedDevices: vi.fn(),
      revokeTrustedDevice: vi.fn(),
      adminReset: vi.fn(),
    };
    passwordReset = { adminReset: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiClientService, useValue: api },
        { provide: MfaApi, useValue: mfa },
        { provide: PasswordResetApi, useValue: passwordReset },
      ],
    });
    service = TestBed.inject(AuthService);
  });

  describe('login', () => {
    it('completes authentication, holding the token in memory and the session hint', async () => {
      api.post.mockReturnValue(of({ data: authResp() }));

      const result = await firstValueFrom(service.login('admin@ftd.io', 'pw'));

      expect(result.status).toBe('authenticated');
      expect(service.isAuthenticated()).toBe(true);
      expect(service.getToken()).toBe('tok-123');
      expect(service.principal()?.permissions).toEqual(['customers.read']);
      expect(service.mfaPending()).toBe(false);
      expect(service.hasSessionHint()).toBe(true);
    });

    it('holds a pending-MFA gate and grants NO session on mfa_required', async () => {
      api.post.mockReturnValue(of({ data: { status: 'mfa_required' } }));

      await firstValueFrom(service.login('admin@ftd.io', 'pw'));

      expect(service.mfaPending()).toBe(true);
      expect(service.isAuthenticated()).toBe(false);
      expect(service.getToken()).toBeNull();
      expect(service.hasSessionHint()).toBe(false);
    });

    it('fails closed on a malformed authenticated payload that carries no token', async () => {
      api.post.mockReturnValue(of({ data: { status: 'authenticated' } }));

      await expect(firstValueFrom(service.login('admin@ftd.io', 'pw'))).rejects.toThrow(
        'Unexpected authentication response',
      );
      expect(service.isAuthenticated()).toBe(false);
    });
  });

  describe('hasPermission (fail-closed UI gate)', () => {
    it('returns false before the principal loads', () => {
      expect(service.hasPermission('customers.read')).toBe(false);
    });

    it('reflects the granted permissions after login', async () => {
      api.post.mockReturnValue(
        of({ data: authResp({ permissions: ['customers.read', 'wallets.manage-limits'] }) }),
      );
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));

      expect(service.hasPermission('wallets.manage-limits')).toBe(true);
      expect(service.hasPermission('customers.delete')).toBe(false);
    });
  });

  describe('mfaVerify', () => {
    it('completes authentication after a valid second factor', async () => {
      mfa.verify.mockReturnValue(of(authResp({ accessToken: 'mfa-tok' })));

      await firstValueFrom(service.mfaVerify('123456', false));

      expect(mfa.verify).toHaveBeenCalledWith('123456', false);
      expect(service.isAuthenticated()).toBe(true);
      expect(service.getToken()).toBe('mfa-tok');
      expect(service.mfaPending()).toBe(false);
    });
  });

  describe('mfaVerifyBackupCode', () => {
    it('completes authentication after a valid backup code', async () => {
      mfa.verifyBackupCode.mockReturnValue(of(authResp({ accessToken: 'backup-tok' })));

      await firstValueFrom(service.mfaVerifyBackupCode('ABCDE-FGHIJ'));

      expect(mfa.verifyBackupCode).toHaveBeenCalledWith('ABCDE-FGHIJ');
      expect(service.isAuthenticated()).toBe(true);
      expect(service.getToken()).toBe('backup-tok');
    });
  });

  describe('MFA enrolment passthroughs', () => {
    it('mfaSetupStart forwards the password to MfaApi.setupStart', async () => {
      mfa.setupStart.mockReturnValue(of({ otpauthUri: 'otpauth://x', manualKey: 'KEY' }));

      const res = await firstValueFrom(service.mfaSetupStart('pw'));

      expect(mfa.setupStart).toHaveBeenCalledWith('pw');
      expect(res.manualKey).toBe('KEY');
    });

    it('mfaSetupConfirm activates MFA and quietly refreshes the principal so mfaEnabled flips', async () => {
      mfa.setupConfirm.mockReturnValue(of({ backupCodes: ['a', 'b'] }));
      api.get.mockReturnValue(of({ data: principal })); // the quiet /auth/me re-read

      const res = await firstValueFrom(service.mfaSetupConfirm('123456'));

      expect(mfa.setupConfirm).toHaveBeenCalledWith('123456');
      expect(res.backupCodes).toEqual(['a', 'b']);
      // refreshPrincipalQuietly → loadPrincipal → /auth/me sets the principal (mfaEnabled true).
      expect(api.get).toHaveBeenCalledWith('/auth/me');
      expect(service.mfaEnabled()).toBe(true);
    });

    it('mfaSetupConfirm tolerates a quiet-refresh failure (best-effort; the confirm still resolves)', async () => {
      mfa.setupConfirm.mockReturnValue(of({ backupCodes: ['a'] }));
      api.get.mockReturnValue(throwError(() => new Error('me-failed')));

      await expect(firstValueFrom(service.mfaSetupConfirm('123456'))).resolves.toEqual({
        backupCodes: ['a'],
      });
    });

    it('mfaDisable disables MFA and quietly refreshes the principal', async () => {
      mfa.disable.mockReturnValue(of(undefined));
      api.get.mockReturnValue(
        of({ data: { ...principal, user: { ...principal.user, mfaEnabled: false } } }),
      );

      await firstValueFrom(service.mfaDisable('pw', '123456'));

      expect(mfa.disable).toHaveBeenCalledWith('pw', '123456');
      expect(service.mfaEnabled()).toBe(false);
    });

    it('mfaRegenerateBackupCodes forwards the password + code and returns the fresh set', async () => {
      mfa.regenerateBackupCodes.mockReturnValue(of({ backupCodes: ['x', 'y'] }));

      const res = await firstValueFrom(service.mfaRegenerateBackupCodes('pw', '123456'));

      expect(mfa.regenerateBackupCodes).toHaveBeenCalledWith('pw', '123456');
      expect(res.backupCodes).toEqual(['x', 'y']);
    });
  });

  describe('trusted-device + admin passthroughs (touch no local session)', () => {
    it('mfaListDevices lists the operator’s own remembered devices', async () => {
      const devices = [{ id: 'd1', lastUsedAt: '2026-06-20T00:00:00Z' }];
      mfa.listTrustedDevices.mockReturnValue(of(devices));

      await expect(firstValueFrom(service.mfaListDevices())).resolves.toEqual(devices);
      expect(mfa.listTrustedDevices).toHaveBeenCalledTimes(1);
    });

    it('mfaRevokeDevice revokes a single trusted device by id', async () => {
      mfa.revokeTrustedDevice.mockReturnValue(of(undefined));

      await firstValueFrom(service.mfaRevokeDevice('d1'));

      expect(mfa.revokeTrustedDevice).toHaveBeenCalledWith('d1');
    });

    it('mfaAdminReset passes the TARGET user id through and mutates no local auth state', async () => {
      api.post.mockReturnValueOnce(of({ data: authResp() }));
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));
      const before = service.principal();
      mfa.adminReset.mockReturnValue(of(undefined));

      await firstValueFrom(service.mfaAdminReset('target-uuid'));

      expect(mfa.adminReset).toHaveBeenCalledWith('target-uuid');
      // The current session/principal is untouched by a target-user reset.
      expect(service.principal()).toBe(before);
      expect(service.isAuthenticated()).toBe(true);
    });

    it('adminResetPassword passes the target id + new password through to PasswordResetApi', async () => {
      passwordReset.adminReset.mockReturnValue(of(undefined));

      await firstValueFrom(service.adminResetPassword('target-uuid', 'Aa1!aaaaaaaa'));

      expect(passwordReset.adminReset).toHaveBeenCalledWith('target-uuid', 'Aa1!aaaaaaaa');
      // Touches another user only — the current session is unchanged.
      expect(service.isAuthenticated()).toBe(false);
    });
  });

  describe('mfaPending gate', () => {
    it('cancelMfaPending clears the pending flag so /mfa/verify is no longer admissible', async () => {
      api.post.mockReturnValue(of({ data: { status: 'mfa_required' } }));
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));
      expect(service.mfaPending()).toBe(true);

      service.cancelMfaPending();

      expect(service.mfaPending()).toBe(false);
    });
  });

  describe('mfaEnabled (derived from the principal)', () => {
    it('is false before the principal loads and false when the operator has MFA off', async () => {
      expect(service.mfaEnabled()).toBe(false); // no principal yet → ?? false
      api.post.mockReturnValue(of({ data: authResp() })); // authResp user.mfaEnabled = false
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));
      expect(service.mfaEnabled()).toBe(false);
    });
  });

  describe('refresh', () => {
    it('rotates the in-memory access token', async () => {
      api.post.mockReturnValue(of({ data: { accessToken: 'rotated', expiresIn: 900 } }));

      const token = await firstValueFrom(service.refresh());

      expect(token).toBe('rotated');
      expect(service.getToken()).toBe('rotated');
    });

    it('is single-flight — concurrent callers share one in-flight request', () => {
      api.post.mockReturnValue(of({ data: { accessToken: 'rotated', expiresIn: 900 } }));

      const first = service.refresh();
      const second = service.refresh();

      expect(first).toBe(second);
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it('clears the session when refresh fails (expired/missing cookie → 401)', async () => {
      api.post.mockReturnValueOnce(of({ data: authResp() }));
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));
      expect(service.isAuthenticated()).toBe(true);

      api.post.mockReturnValueOnce(throwError(() => new Error('401')));
      await expect(firstValueFrom(service.refresh())).rejects.toThrow();

      expect(service.isAuthenticated()).toBe(false);
      expect(service.hasSessionHint()).toBe(false);
    });
  });

  describe('loadPrincipal', () => {
    it('loads the principal from /auth/me', async () => {
      api.get.mockReturnValue(of({ data: principal }));

      const loaded = await firstValueFrom(service.loadPrincipal());

      expect(loaded).toEqual(principal);
      expect(service.principal()).toEqual(principal);
      expect(service.mfaEnabled()).toBe(true);
    });
  });

  describe('logout', () => {
    it('clears the in-memory session synchronously, then revokes server-side', async () => {
      api.post.mockReturnValueOnce(of({ data: authResp() }));
      await firstValueFrom(service.login('admin@ftd.io', 'pw'));

      api.post.mockReturnValueOnce(of(undefined));
      const logout$ = service.logout();
      // Session is dropped immediately, before the network call resolves.
      expect(service.isAuthenticated()).toBe(false);
      expect(service.hasSessionHint()).toBe(false);

      await firstValueFrom(logout$);
      expect(api.post).toHaveBeenLastCalledWith('/auth/logout', {}, expect.anything());
    });

    it('still resolves when the revoke call errors (best-effort cleanup)', async () => {
      api.post.mockReturnValue(throwError(() => new Error('network')));

      await expect(firstValueFrom(service.logout())).resolves.toBeUndefined();
      expect(service.isAuthenticated()).toBe(false);
    });
  });
});
