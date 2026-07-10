/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpContext, HttpErrorResponse, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject, defer, lastValueFrom, of, throwError } from 'rxjs';
import { ApiClientService } from '@core/api/api-client.service';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import { authGuard } from './auth.guard';
import { authInterceptor } from '@core/interceptors/auth.interceptor';
import { SILENT_REQUEST } from '@core/http/silent-request.token';
import { MfaApi } from '@core/api/mfa.api';
import type { AuthenticatedResponse, RefreshResponse } from './auth.model';

const LOGIN_RESPONSE: AuthenticatedResponse = {
  status: 'authenticated',
  accessToken: 'access-tok',
  tokenType: 'Bearer',
  expiresIn: 900,
  permissions: ['customers.read'],
  user: { id: 'u1', displayName: 'Operator', email: 'o***@e***.com', mfaEnabled: false },
};

const REFRESH_RESPONSE: RefreshResponse = {
  accessToken: 'access-tok-2',
  expiresIn: 900,
};

/** The refresh cookie is httpOnly — only the 3 /auth/* calls opt in with withCredentials. */
const WITH_COOKIE = { withCredentials: true };

describe('AuthService', () => {
  let api: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let mfa: {
    verify: ReturnType<typeof vi.fn>;
    verifyBackupCode: ReturnType<typeof vi.fn>;
    setupStart: ReturnType<typeof vi.fn>;
    setupConfirm: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
    regenerateBackupCodes: ReturnType<typeof vi.fn>;
    adminReset: ReturnType<typeof vi.fn>;
  };
  let service: AuthService;

  beforeEach(() => {
    localStorage.clear();
    api = {
      post: vi.fn(() => of({ data: LOGIN_RESPONSE })),
      get: vi.fn(() =>
        of({ data: { user: LOGIN_RESPONSE.user, permissions: LOGIN_RESPONSE.permissions } }),
      ),
    };
    mfa = {
      verify: vi.fn(() => of(LOGIN_RESPONSE)),
      verifyBackupCode: vi.fn(() => of(LOGIN_RESPONSE)),
      setupStart: vi.fn(() =>
        of({ otpauthUri: 'otpauth://x', qrDataUrl: 'data:image/png;base64,x' }),
      ),
      setupConfirm: vi.fn(() => of({ backupCodes: ['AAAA-AAAA'] })),
      disable: vi.fn(() => of(undefined)),
      regenerateBackupCodes: vi.fn(() => of({ backupCodes: ['BBBB-BBBB'] })),
      adminReset: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: ApiClientService, useValue: api },
        { provide: MfaApi, useValue: mfa },
      ],
    });
    service = TestBed.inject(AuthService);
  });

  it('starts unauthenticated', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.getToken()).toBeNull();
  });

  it('holds the access token + principal in memory on login — never web storage (withCredentials, no refresh body)', async () => {
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    const [path, body, opts] = api.post.mock.calls.at(-1) as [
      string,
      unknown,
      { withCredentials?: boolean; context?: HttpContext },
    ];
    expect(path).toBe('/auth/login');
    expect(body).toEqual({ email: 'operator@example.com', password: 'Test-Passw0rd!' });
    expect(opts.withCredentials).toBe(true);
    // Login errors render inline (LoginComponent banner) → SILENT_REQUEST suppresses the duplicate toast.
    expect(opts.context?.get(SILENT_REQUEST)).toBe(true);
    expect(service.isAuthenticated()).toBe(true);
    expect(service.getToken()).toBe('access-tok');
    // The access token must NOT be written to web storage (XSS at-rest exposure).
    expect(localStorage.getItem('ftd_access_token')).toBeNull();
    expect(service.principal()?.permissions).toContain('customers.read');
  });

  it('clears the access token + principal from memory on logout', async () => {
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    service.logout();
    expect(service.isAuthenticated()).toBe(false);
    expect(service.getToken()).toBeNull();
    expect(service.principal()).toBeNull();
  });

  it('revokes the session server-side on logout (cookie sent via withCredentials, no body token)', async () => {
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    api.post.mockClear();
    api.post.mockReturnValueOnce(of(undefined));

    await lastValueFrom(service.logout());

    expect(api.post).toHaveBeenCalledWith('/auth/logout', {}, WITH_COOKIE);
    expect(service.getToken()).toBeNull();
  });

  it('still clears the session and completes when /auth/logout fails', async () => {
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    api.post.mockClear();
    api.post.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 500 })));

    await expect(lastValueFrom(service.logout())).resolves.toBeUndefined();

    expect(api.post).toHaveBeenCalledWith('/auth/logout', {}, WITH_COOKIE);
    expect(service.getToken()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('still calls /auth/logout when there is no JS token so a stale httpOnly cookie can be cleared', async () => {
    api.post.mockClear();
    api.post.mockReturnValueOnce(of(undefined));
    await expect(lastValueFrom(service.logout())).resolves.toBeUndefined();
    expect(api.post).toHaveBeenCalledWith('/auth/logout', {}, WITH_COOKIE);
  });

  it('never writes the access OR refresh token to web storage on login (in-memory token + httpOnly refresh cookie)', async () => {
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    // Access token in memory only; refresh token in an httpOnly cookie. Neither in web storage.
    expect(localStorage.getItem('ftd_access_token')).toBeNull();
    expect(sessionStorage.getItem('ftd_access_token')).toBeNull();
    expect(localStorage.getItem('ftd_refresh_token')).toBeNull();
  });

  it('sets the non-sensitive session hint on login and clears it on logout (bootstrap probe gate)', async () => {
    expect(service.hasSessionHint()).toBe(false);
    await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    // A boolean presence flag only — never a token; gates the bootstrap probe
    // so an anonymous first visit never calls /auth/refresh.
    expect(service.hasSessionHint()).toBe(true);
    expect(localStorage.getItem('ftd_session')).toBe('1');
    service.logout();
    expect(service.hasSessionHint()).toBe(false);
    expect(localStorage.getItem('ftd_session')).toBeNull();
  });

  describe('hasPermission() — RBAC UI gate', () => {
    // The seeded operator the dashboard logs in as. Codes verified against the live
    // GET /auth/me principal — note `wallets.manage-limits` (the `wallets.manage` capability
    // for limit edits was retired), and the action codes the gates consume.
    const FULL_PERMISSIONS = [
      'audit-logs.read',
      'customers.manage',
      'customers.read',
      'kyc.manage',
      'kyc.read',
      'permissions.manage',
      'roles.manage',
      'roles.read',
      'transactions.create',
      'transactions.read',
      'users.manage',
      'wallets.manage',
      'wallets.manage-limits',
      'wallets.read',
    ];

    function loginWith(permissions: string[]): Promise<unknown> {
      api.post.mockReturnValueOnce(of({ data: { ...LOGIN_RESPONSE, permissions } }));
      return lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
    }

    it('fails closed before the principal loads (no principal → false)', () => {
      expect(service.principal()).toBeNull();
      expect(service.hasPermission('customers.manage')).toBe(false);
      expect(service.hasPermission('wallets.manage-limits')).toBe(false);
    });

    it('returns true for every action code a full-permission operator holds', async () => {
      await loginWith(FULL_PERMISSIONS);
      // The exact codes the three gated surfaces consume:
      expect(service.hasPermission('customers.manage')).toBe(true); // create/edit/delete customer
      expect(service.hasPermission('wallets.manage-limits')).toBe(true); // wallet limit save
      expect(service.hasPermission('kyc.manage')).toBe(true); // web3 risk decision record
      expect(service.hasPermission('transactions.create')).toBe(true);
    });

    it('gates correctly for a REDUCED-permission operator (the defense-in-depth case)', async () => {
      // Read-only operator: can view customers but holds NONE of the manage/action codes.
      await loginWith(['customers.read', 'wallets.read', 'kyc.read', 'transactions.read']);
      expect(service.hasPermission('customers.manage')).toBe(false);
      expect(service.hasPermission('wallets.manage-limits')).toBe(false);
      expect(service.hasPermission('kyc.manage')).toBe(false);
      expect(service.hasPermission('transactions.create')).toBe(false);
      // A held read permission still resolves true, proving it reads the real set (not hardcoded).
      expect(service.hasPermission('customers.read')).toBe(true);
    });

    it('does NOT treat the retired `wallets.manage` as the limit-save capability', async () => {
      // Operator granted the OLD code only — limit save (gated on wallets.manage-limits) stays closed.
      await loginWith(['wallets.manage']);
      expect(service.hasPermission('wallets.manage')).toBe(true);
      expect(service.hasPermission('wallets.manage-limits')).toBe(false);
    });

    it('ignores unknown/extra permission strings', async () => {
      await loginWith(['customers.read']);
      expect(service.hasPermission('totally.unknown')).toBe(false);
      expect(service.hasPermission('')).toBe(false);
    });

    it('reflects the rehydrated principal after /auth/me, then closes on logout', async () => {
      // Reload path: only the token is persisted; loadPrincipal() refreshes permissions from the server.
      api.get.mockReturnValueOnce(
        of({ data: { user: LOGIN_RESPONSE.user, permissions: ['kyc.manage'] } }),
      );
      await lastValueFrom(service.loadPrincipal());
      expect(service.hasPermission('kyc.manage')).toBe(true);
      expect(service.hasPermission('customers.manage')).toBe(false);

      service.logout();
      expect(service.hasPermission('kyc.manage')).toBe(false);
    });
  });

  describe('MFA login flow', () => {
    it('login → mfa_required sets mfaPending and grants NO session (AC1, AC8)', async () => {
      api.post.mockReturnValueOnce(of({ data: { status: 'mfa_required' } }));
      const result = await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      expect(result).toEqual({ status: 'mfa_required' });
      expect(service.mfaPending()).toBe(true);
      // No access token before the factor passes.
      expect(service.isAuthenticated()).toBe(false);
      expect(service.getToken()).toBeNull();
      expect(service.principal()).toBeNull();
    });

    it('login → authenticated completes login and leaves mfaPending false', async () => {
      const result = await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      expect(result).toEqual(LOGIN_RESPONSE);
      expect(service.isAuthenticated()).toBe(true);
      expect(service.mfaPending()).toBe(false);
    });

    it('mfaVerify completes login (token+principal set) and clears mfaPending (AC2)', async () => {
      // Simulate the pending state from a prior mfa_required login.
      api.post.mockReturnValueOnce(of({ data: { status: 'mfa_required' } }));
      await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      expect(service.mfaPending()).toBe(true);

      await lastValueFrom(service.mfaVerify('123456', false));
      expect(mfa.verify).toHaveBeenCalledWith('123456', false);
      expect(service.getToken()).toBe('access-tok');
      expect(service.principal()?.permissions).toContain('customers.read');
      expect(service.mfaPending()).toBe(false);
      expect(service.isAuthenticated()).toBe(true);
    });

    it('mfaVerify forwards the rememberDevice flag only as passed (AC4)', async () => {
      await lastValueFrom(service.mfaVerify('123456', true));
      expect(mfa.verify).toHaveBeenCalledWith('123456', true);
    });

    it('mfaVerifyBackupCode completes login the same way (AC3)', async () => {
      await lastValueFrom(service.mfaVerifyBackupCode('AAAAA-BBBBB'));
      expect(mfa.verifyBackupCode).toHaveBeenCalledWith('AAAAA-BBBBB');
      expect(service.getToken()).toBe('access-tok');
      expect(service.isAuthenticated()).toBe(true);
    });

    it('a failed mfaVerify grants no session (token stays null, pending unchanged)', async () => {
      api.post.mockReturnValueOnce(of({ data: { status: 'mfa_required' } }));
      await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      mfa.verify.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
      await expect(lastValueFrom(service.mfaVerify('000000', false))).rejects.toBeTruthy();
      expect(service.getToken()).toBeNull();
      expect(service.mfaPending()).toBe(true);
      expect(service.isAuthenticated()).toBe(false);
    });

    it('mfaEnabled reflects the principal user flag', async () => {
      api.get.mockReturnValueOnce(
        of({ data: { user: { ...LOGIN_RESPONSE.user, mfaEnabled: true }, permissions: [] } }),
      );
      await lastValueFrom(service.loadPrincipal());
      expect(service.mfaEnabled()).toBe(true);
    });

    it('mfaSetupStart / mfaSetupConfirm delegate to MfaApi; confirm refreshes the principal', async () => {
      const start = await lastValueFrom(service.mfaSetupStart('Test-Passw0rd!'));
      expect(mfa.setupStart).toHaveBeenCalledWith('Test-Passw0rd!');
      expect(start.qrDataUrl).toContain('data:image');

      api.get.mockClear();
      const confirm = await lastValueFrom(service.mfaSetupConfirm('123456'));
      expect(mfa.setupConfirm).toHaveBeenCalledWith('123456');
      expect(confirm.backupCodes).toEqual(['AAAA-AAAA']);
      // Principal is refreshed (/auth/me) so mfaEnabled re-reads after activation.
      expect(api.get).toHaveBeenCalled();
    });

    it('mfaDisable / mfaRegenerateBackupCodes delegate with password + code', async () => {
      await lastValueFrom(service.mfaDisable('Test-Passw0rd!', '123456'));
      expect(mfa.disable).toHaveBeenCalledWith('Test-Passw0rd!', '123456');

      const regen = await lastValueFrom(
        service.mfaRegenerateBackupCodes('Test-Passw0rd!', '123456'),
      );
      expect(mfa.regenerateBackupCodes).toHaveBeenCalledWith('Test-Passw0rd!', '123456');
      expect(regen.backupCodes).toEqual(['BBBB-BBBB']);
    });

    it('mfaAdminReset delegates to MfaApi with the target userId and mutates no local session', async () => {
      await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      const tokenBefore = service.getToken();
      const principalBefore = service.principal();

      await lastValueFrom(service.mfaAdminReset('11111111-1111-1111-1111-111111111111'));
      expect(mfa.adminReset).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
      // A passthrough: the current operator's own session/principal is untouched.
      expect(service.getToken()).toBe(tokenBefore);
      expect(service.principal()).toBe(principalBefore);
    });

    it('logout clears any pending-MFA state', async () => {
      api.post.mockReturnValueOnce(of({ data: { status: 'mfa_required' } }));
      await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      expect(service.mfaPending()).toBe(true);
      service.logout();
      expect(service.mfaPending()).toBe(false);
    });
  });

  describe('refresh()', () => {
    beforeEach(async () => {
      await lastValueFrom(service.login('operator@example.com', 'Test-Passw0rd!'));
      api.post.mockClear();
    });

    it('marks the bootstrap probe SILENT_REQUEST so it cannot flash an error toast (silent=true)', async () => {
      api.post.mockReturnValueOnce(of({ data: REFRESH_RESPONSE }));
      await lastValueFrom(service.refresh(true));
      const opts = api.post.mock.calls.at(-1)?.[2] as
        | { withCredentials?: boolean; context?: HttpContext }
        | undefined;
      expect(opts?.withCredentials).toBe(true);
      expect(opts?.context?.get(SILENT_REQUEST)).toBe(true);
    });

    it('does NOT mark a normal mid-session refresh silent (so genuine expiry still notifies)', async () => {
      api.post.mockReturnValueOnce(of({ data: REFRESH_RESPONSE }));
      await lastValueFrom(service.refresh());
      const opts = api.post.mock.calls.at(-1)?.[2] as { context?: HttpContext } | undefined;
      expect(opts?.context?.get(SILENT_REQUEST) ?? false).toBe(false);
    });

    it('rotates the access token via the cookie (withCredentials, empty body) and returns it', async () => {
      api.post.mockReturnValueOnce(of({ data: REFRESH_RESPONSE }));
      const newToken = await lastValueFrom(service.refresh());
      expect(api.post).toHaveBeenCalledWith('/auth/refresh', {}, WITH_COOKIE);
      expect(newToken).toBe('access-tok-2');
      expect(service.getToken()).toBe('access-tok-2');
      // The rotated access token stays in memory only; the refresh token rides the httpOnly cookie.
      expect(localStorage.getItem('ftd_access_token')).toBeNull();
      expect(localStorage.getItem('ftd_refresh_token')).toBeNull();
    });

    it('is single-flight: concurrent calls share ONE /auth/refresh request', async () => {
      const gate = new Subject<{ data: RefreshResponse }>();
      api.post.mockReturnValueOnce(gate.asObservable());

      const first = lastValueFrom(service.refresh());
      const second = lastValueFrom(service.refresh());
      expect(api.post).toHaveBeenCalledTimes(1);

      gate.next({ data: REFRESH_RESPONSE });
      gate.complete();
      expect(await first).toBe('access-tok-2');
      expect(await second).toBe('access-tok-2');
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh refresh after the in-flight one settles', async () => {
      api.post.mockReturnValueOnce(of({ data: REFRESH_RESPONSE }));
      await lastValueFrom(service.refresh());
      api.post.mockReturnValueOnce(of({ data: REFRESH_RESPONSE }));
      await lastValueFrom(service.refresh());
      expect(api.post).toHaveBeenCalledTimes(2);
    });

    it('clears the session when refresh itself fails (cookie missing/expired/reused → 401)', async () => {
      api.post.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
      await expect(lastValueFrom(service.refresh())).rejects.toBeTruthy();
      expect(api.post).toHaveBeenCalledWith('/auth/refresh', {}, WITH_COOKIE);
      expect(service.getToken()).toBeNull();
      expect(service.principal()).toBeNull();
    });

    it('clears the session hint when refresh fails, so a stale hint self-heals on the next load', async () => {
      expect(service.hasSessionHint()).toBe(true); // set by this block's login beforeEach
      api.post.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
      await expect(lastValueFrom(service.refresh())).rejects.toBeTruthy();
      expect(service.hasSessionHint()).toBe(false);
    });

    it('always calls /auth/refresh (the cookie is the source of truth, not a JS-held token)', async () => {
      // Even with no access token in JS, refresh() attempts the call; the backend decides via the
      // httpOnly cookie. A missing cookie comes back as a 401, which clears the session.
      service.logout();
      api.post.mockClear();
      api.post.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
      await expect(lastValueFrom(service.refresh())).rejects.toBeTruthy();
      expect(api.post).toHaveBeenCalledWith('/auth/refresh', {}, WITH_COOKIE);
    });
  });

  describe('loadPrincipal() — single-flight /auth/me', () => {
    const ME = { data: { user: LOGIN_RESPONSE.user, permissions: ['customers.read'] } };

    it('is single-flight: concurrent rehydrate callers share ONE /auth/me request', async () => {
      // The guarded-deep-link-reload race: permissionGuard + MainLayout.ngOnInit both ask for the
      // principal before the first /auth/me resolves. They must collapse onto one in-flight call.
      const gate = new Subject<typeof ME>();
      api.get.mockReturnValueOnce(gate.asObservable());

      const first = lastValueFrom(service.loadPrincipal());
      const second = lastValueFrom(service.loadPrincipal());
      expect(api.get).toHaveBeenCalledTimes(1);

      gate.next(ME);
      gate.complete();
      await first;
      await second;
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(service.principal()?.permissions).toContain('customers.read');
    });

    it('re-fetches on a fresh rehydrate after the in-flight one settles', async () => {
      api.get.mockReturnValueOnce(of(ME));
      await lastValueFrom(service.loadPrincipal());
      api.get.mockReturnValueOnce(of(ME));
      await lastValueFrom(service.loadPrincipal());
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });
});

describe('authGuard', () => {
  function run(isAuthenticated: boolean) {
    const router = { createUrlTree: vi.fn(() => 'URLTREE') };
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { isAuthenticated: () => isAuthenticated } },
        { provide: Router, useValue: router },
      ],
    });
    const result = TestBed.runInInjectionContext(() =>
      authGuard({} as never, { url: '/dashboard' } as never),
    );
    return { result, router };
  }

  it('allows an authenticated operator', () => {
    expect(run(true).result).toBe(true);
  });

  it('redirects to /login with returnUrl when unauthenticated', () => {
    const { result, router } = run(false);
    expect(result).toBe('URLTREE');
    expect(router.createUrlTree).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/dashboard' },
    });
  });
});

describe('authInterceptor', () => {
  let auth: {
    getToken: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    auth = {
      getToken: vi.fn(() => 'access-tok'),
      logout: vi.fn(() => of(undefined)),
      refresh: vi.fn(() => of('access-tok-2')),
    };
    router = { navigate: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('attaches the Bearer token to API requests', async () => {
    const req = new HttpRequest('GET', `${environment.apiBaseUrl}/dashboard/summary`);
    const next = vi.fn((r: HttpRequest<unknown>) => of(new HttpResponse({ status: 200 })));
    await TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never)));
    expect(next.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer access-tok');
  });

  it('does NOT attach a token to the login endpoint', async () => {
    const req = new HttpRequest('POST', `${environment.apiBaseUrl}/auth/login`, {});
    const next = vi.fn((r: HttpRequest<unknown>) => of(new HttpResponse({ status: 200 })));
    await TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never)));
    expect(next.mock.calls[0][0].headers.get('Authorization')).toBeNull();
  });

  it('leaves non-API requests untouched (no Bearer for e.g. Web3 RPC reads)', async () => {
    const req = new HttpRequest('POST', environment.web3.rpcUrl, {});
    const next = vi.fn((r: HttpRequest<unknown>) => of(new HttpResponse({ status: 200 })));
    await TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never)));
    expect(next.mock.calls[0][0]).toBe(req);
    expect(next.mock.calls[0][0].headers.has('Authorization')).toBe(false);
  });

  it('on 401: refreshes, retries the original request with the new token, and succeeds', async () => {
    const url = `${environment.apiBaseUrl}/dashboard/summary`;
    const req = new HttpRequest('GET', url);
    const err = new HttpErrorResponse({ status: 401, url });
    const ok = new HttpResponse({ status: 200 });
    const next = vi
      .fn()
      .mockReturnValueOnce(throwError(() => err)) // first attempt fails
      .mockReturnValueOnce(of(ok)); // retry succeeds

    const res = await TestBed.runInInjectionContext(() =>
      lastValueFrom(authInterceptor(req, next as never)),
    );

    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next.mock.calls[1][0].headers.get('Authorization')).toBe('Bearer access-tok-2');
    expect(res).toBe(ok);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('on 401 when refresh fails: logs out (subscribes the cold call) + redirects to /login (no retry loop)', async () => {
    const url = `${environment.apiBaseUrl}/dashboard/summary`;
    const req = new HttpRequest('GET', url);
    const err = new HttpErrorResponse({ status: 401, url });
    auth.refresh.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 401 })));
    // `logout()` returns a COLD observable (the HTTP revoke fires only on subscribe). `defer`'s
    // factory runs only when subscribed, so this pins that the interceptor calls `.subscribe()` —
    // dropping the `.subscribe()` would leave the revoke unsent and fail this assertion.
    let logoutSubscribed = false;
    auth.logout.mockReturnValueOnce(
      defer(() => {
        logoutSubscribed = true;
        return of(undefined);
      }),
    );
    const next = vi.fn(() => throwError(() => err));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never))),
    ).rejects.toBeTruthy();

    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1); // original only; no retry after refresh failure
    expect(auth.logout).toHaveBeenCalled();
    expect(logoutSubscribed).toBe(true); // the cold logout observable was actually subscribed
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('does NOT attach a token OR refresh on a 401 for the MFA verify endpoint', async () => {
    // The login-flow MFA verify runs with the ftd_mfa cookie, no Bearer; a bad/expired code (401)
    // must surface inline, not kick off the refresh-and-retry loop.
    const url = `${environment.apiBaseUrl}/auth/mfa/verify`;
    const req = new HttpRequest('POST', url, {});
    const err = new HttpErrorResponse({ status: 401, url });
    const next = vi.fn(() => throwError(() => err));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never))),
    ).rejects.toBeTruthy();

    expect(next.mock.calls[0][0].headers.get('Authorization')).toBeNull();
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT attach a token OR refresh on a 401 from the password-reset endpoints', async () => {
    // The self-service reset endpoints are public + cookie-credentialed (`ftd_pwreset`) and run with
    // NO session: their 401s are mapped inline by the reset wizard. A refresh attempt for an
    // anonymous visitor would itself 401 and wrongly logout-redirect away from the wizard.
    const url = `${environment.apiBaseUrl}/auth/password/reset/verify-code`;
    const req = new HttpRequest('POST', url, {});
    const err = new HttpErrorResponse({ status: 401, url });
    const next = vi.fn(() => throwError(() => err));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never))),
    ).rejects.toBe(err);

    expect(next.mock.calls[0][0].headers.get('Authorization')).toBeNull();
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('DOES attach a Bearer token to the Bearer-flow MFA endpoints (setup/disable)', async () => {
    const req = new HttpRequest('POST', `${environment.apiBaseUrl}/auth/mfa/disable`, {});
    const next = vi.fn(() => of(new HttpResponse({ status: 204 })));
    await TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never)));
    expect(next.mock.calls[0][0].headers.get('Authorization')).toBe('Bearer access-tok');
  });

  it('does NOT attempt refresh for a 401 on the refresh endpoint itself', async () => {
    const url = `${environment.apiBaseUrl}/auth/refresh`;
    const req = new HttpRequest('POST', url, {});
    const err = new HttpErrorResponse({ status: 401, url });
    const next = vi.fn(() => throwError(() => err));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never))),
    ).rejects.toBeTruthy();

    expect(auth.refresh).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does NOT refresh on a non-401 API error', async () => {
    const url = `${environment.apiBaseUrl}/dashboard/summary`;
    const req = new HttpRequest('GET', url);
    const err = new HttpErrorResponse({ status: 500, url });
    const next = vi.fn(() => throwError(() => err));

    await expect(
      TestBed.runInInjectionContext(() => lastValueFrom(authInterceptor(req, next as never))),
    ).rejects.toBeTruthy();

    expect(auth.refresh).not.toHaveBeenCalled();
  });
});
