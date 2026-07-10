/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';

import { HealthApi, HealthStatus } from '@core/api/health.api';
import { NotificationPreferences, OperatorApi, OperatorProfile } from '@core/api/operator.api';
import { RbacApi, RbacPermission, RbacRole } from '@core/api/rbac.api';
import { DensityService, DensityMode } from '@core/services/density.service';
import { ThemeService, ThemeMode } from '@core/services/theme.service';
import { ToastService } from '@core/services/toast.service';
import { AuthService } from '@core/auth/auth.service';
import { SettingsComponent } from './settings.component';

/**
 * AuthService stub: grants the listed permission codes (RBAC gating; defaults to
 * roles.read), exposes a fixed `mfaEnabled` readout, and records the MFA action calls.
 */
function authMock(
  granted: string[] = ['roles.read'],
  mfaEnabled = false,
  lastLogin: string | null = null,
) {
  return {
    hasPermission: (p: string) => granted.includes(p),
    principal: () => ({
      user: {
        id: 'user-1',
        displayName: 'Operator',
        email: 'operator@example.com',
        mfaEnabled,
        lastLoginAt: lastLogin,
      },
      permissions: granted,
    }),
    mfaEnabled: () => mfaEnabled,
    mfaDisable: vi.fn(() => of(undefined)),
    mfaRegenerateBackupCodes: vi.fn(() => of({ backupCodes: ['NEW1-NEW1', 'NEW2-NEW2'] })),
    // Trusted devices: default to two active devices; revoke succeeds.
    mfaListDevices: vi.fn(() => of(twoDevices())),
    mfaRevokeDevice: vi.fn(() => of(undefined)),
  } as unknown as AuthService & {
    mfaDisable: ReturnType<typeof vi.fn>;
    mfaRegenerateBackupCodes: ReturnType<typeof vi.fn>;
    mfaListDevices: ReturnType<typeof vi.fn>;
    mfaRevokeDevice: ReturnType<typeof vi.fn>;
  };
}

/** Two active remembered devices matching the real backend `RememberedDevice` shape (ISO-string dates). */
function twoDevices() {
  return [
    {
      id: 'dev-1',
      createdAt: '2026-06-01T10:00:00.000Z',
      expiresAt: '2026-07-01T10:00:00.000Z',
      ipPrefix: '203.0.113.0/24',
    },
    {
      id: 'dev-2',
      createdAt: '2026-06-10T12:00:00.000Z',
      expiresAt: '2026-07-10T12:00:00.000Z',
      ipPrefix: '198.51.100.0/24',
    },
  ];
}

/** Minimal ThemeService stub: records setTheme calls and exposes a fixed live theme. */
function themeMock(initial: ThemeMode = 'light') {
  return {
    theme: () => initial,
    setTheme: vi.fn<(mode: ThemeMode) => void>(),
  } as unknown as ThemeService & { setTheme: ReturnType<typeof vi.fn> };
}

/** DensityService stub: a controllable signal-shaped readout + recorded setter. */
function densityMock(initial: DensityMode = 'comfortable') {
  let current = initial;
  return {
    density: () => current,
    setDensity: vi.fn((mode: DensityMode) => {
      current = mode;
    }),
  } as unknown as DensityService & { setDensity: ReturnType<typeof vi.fn> };
}

/** TranslateService stub: `instant` echoes the key; `use` records the requested lang. */
function i18nMock(currentLang: 'en' | 'tr' = 'en') {
  return {
    currentLang,
    instant: (key: string) => key,
    use: vi.fn(),
  } as unknown as TranslateService & { use: ReturnType<typeof vi.fn> };
}

function toastMock() {
  return { success: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as ToastService & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

function operatorApiMock(
  profile: OperatorProfile = {
    displayName: null,
    email: 'operator@example.com',
    phone: null,
    jobTitle: null,
  },
  prefs: NotificationPreferences = {
    productUpdates: true,
    securityAlerts: true,
    weeklyDigest: false,
  },
) {
  return {
    getProfile: vi.fn(() => of(profile)),
    updateProfile: vi.fn((body: Partial<OperatorProfile>) =>
      of({
        ...profile,
        displayName: body.displayName ?? profile.displayName,
        phone: body.phone !== undefined ? body.phone || null : profile.phone,
        jobTitle: body.jobTitle ?? profile.jobTitle,
      }),
    ),
    getNotificationPreferences: vi.fn(() => of(prefs)),
    updateNotificationPreferences: vi.fn((body: Partial<NotificationPreferences>) =>
      of({ ...prefs, ...body }),
    ),
  } as unknown as OperatorApi & {
    getProfile: ReturnType<typeof vi.fn>;
    updateProfile: ReturnType<typeof vi.fn>;
    getNotificationPreferences: ReturnType<typeof vi.fn>;
    updateNotificationPreferences: ReturnType<typeof vi.fn>;
  };
}

function healthApiMock(status: HealthStatus = { status: 'ok', uptimeSeconds: 42 }) {
  return { getHealth: vi.fn(() => of(status)) } as unknown as HealthApi & {
    getHealth: ReturnType<typeof vi.fn>;
  };
}

function rbacApiMock(
  roles: RbacRole[] = [{ id: 'role-1', name: 'Admin', permissions: ['roles.read'] }],
  permissions: RbacPermission[] = [{ id: 'perm-1', code: 'roles.read' }],
) {
  return {
    listRoles: vi.fn(() => of(roles)),
    listPermissions: vi.fn(() => of(permissions)),
  } as unknown as RbacApi & {
    listRoles: ReturnType<typeof vi.fn>;
    listPermissions: ReturnType<typeof vi.fn>;
  };
}

interface Mounted {
  component: SettingsComponent;
  theme: ReturnType<typeof themeMock>;
  density: ReturnType<typeof densityMock>;
  i18n: ReturnType<typeof i18nMock>;
  toast: ReturnType<typeof toastMock>;
  operator: ReturnType<typeof operatorApiMock>;
  health: ReturnType<typeof healthApiMock>;
  rbac: ReturnType<typeof rbacApiMock>;
  auth: ReturnType<typeof authMock>;
  router: { navigate: ReturnType<typeof vi.fn> };
}

/**
 * Repo-canonical spec style: construct the class inside an injection context (so
 * `inject()` resolves the mocked services) rather than rendering the template —
 * this mirrors dashboard/customer-list specs and avoids TranslateModule wiring.
 */
function mount(
  opts: {
    theme?: ThemeMode;
    lang?: 'en' | 'tr';
    section?: string;
    profile?: OperatorProfile;
    prefs?: NotificationPreferences;
    health?: HealthStatus;
    roles?: RbacRole[];
    permissions?: RbacPermission[];
    auth?: string[];
    mfaEnabled?: boolean;
    /** ISO stamp for the principal's lastLoginAt (redesign v3 header chip); default absent → null. */
    lastLogin?: string;
    /** Simulate the `/settings/mfa` deep-link (route data.mfaAutoOpen). */
    mfaAutoOpen?: boolean;
  } = {},
): Mounted {
  const theme = themeMock(opts.theme ?? 'light');
  const density = densityMock();
  const i18n = i18nMock(opts.lang ?? 'en');
  const toast = toastMock();
  const operator = operatorApiMock(opts.profile, opts.prefs);
  const health = healthApiMock(opts.health);
  const rbac = rbacApiMock(opts.roles, opts.permissions);
  const auth = authMock(
    opts.auth ?? ['roles.read'],
    opts.mfaEnabled ?? false,
    opts.lastLogin ?? null,
  );
  const router = { navigate: vi.fn() };
  const queryParams = opts.section ? { section: opts.section } : {};

  TestBed.configureTestingModule({
    providers: [
      { provide: ThemeService, useValue: theme },
      { provide: DensityService, useValue: density },
      { provide: TranslateService, useValue: i18n },
      { provide: ToastService, useValue: toast },
      { provide: OperatorApi, useValue: operator },
      { provide: HealthApi, useValue: health },
      { provide: RbacApi, useValue: rbac },
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: router },
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: of(convertToParamMap(queryParams)),
          // Route data carries the `/settings/mfa` deep-link auto-open flag.
          data: of(opts.mfaAutoOpen ? { mfaAutoOpen: true } : {}),
        },
      },
    ],
  });

  const component = TestBed.runInInjectionContext(() => new SettingsComponent());
  return { component, theme, density, i18n, toast, operator, health, rbac, auth, router };
}

describe('SettingsComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('starts on the Profile section with the backend-backed sub-nav items in order', () => {
    const { component } = mount();
    expect(component.activeSection).toBe('profile');
    // Security (MFA) sits right after Profile — a REAL backend-backed control.
    expect(component.sections.map(s => s.value)).toEqual([
      'profile',
      'security',
      'appearance',
      'language',
      'notifications',
      'access',
    ]);
  });

  it('keeps the self-scoped access tab visible without roles.read', () => {
    const { component } = mount({ auth: ['customers.read'] }); // no roles.read
    expect(component.sections.map(s => s.value)).toEqual([
      'profile',
      'security',
      'appearance',
      'language',
      'notifications',
      'access',
    ]);
    expect(component.sections.some(s => s.value === 'access')).toBe(true);
  });

  it('shows the access tab when roles.read is held too', () => {
    const { component } = mount({ auth: ['roles.read'] });
    expect(component.sections.some(s => s.value === 'access')).toBe(true);
  });

  it('selectSection opens self-scoped access without roles.read', () => {
    const { component } = mount({ auth: ['customers.read'] });
    component.selectSection('access');
    expect(component.activeSection).toBe('access');
  });

  it('ignores invalid section selections without mutating the route', () => {
    const { component, router } = mount();
    component.selectSection('unknown-section');
    expect(component.activeSection).toBe('profile');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  // --- Identity band role chip (EK-1): the label mirrors the ACTUAL granted role -----------------

  it('labels an administrator session via the admin-only roles.manage marker', () => {
    const { component } = mount({ auth: ['roles.read', 'roles.manage', 'customers.manage'] });
    expect(component.identityRoleKey()).toBe('auth.login.demo.roles.administrator.name');
  });

  it('labels an operator (Compliance Officer) session via customers.manage without roles.manage', () => {
    const { component } = mount({ auth: ['roles.read', 'customers.manage', 'kyc.manage'] });
    expect(component.identityRoleKey()).toBe('auth.login.demo.roles.operator.name');
  });

  it('labels a read-only auditor (Viewer) session — roles.read alone is NOT administrator', () => {
    // Regression (EK-1): every seeded role holds roles.read, so it must not map to "Administrator".
    const { component } = mount({ auth: ['roles.read', 'customers.read'] });
    expect(component.identityRoleKey()).toBe('auth.login.demo.roles.auditor.name');
  });

  // --- Security: MFA card (AC6) ---

  it('exposes a real, navigable Security section (MFA replaces the removed fake toggles)', () => {
    const { component } = mount();
    expect(component.sections.some(s => s.value === 'security')).toBe(true);
    component.selectSection('security');
    expect(component.activeSection).toBe('security');
  });

  it('deep-links into the Security section from the query string', () => {
    const { component } = mount({ section: 'security' });
    component.ngOnInit();
    expect(component.activeSection).toBe('security');
  });

  it('reflects the MFA status from the principal (disabled vs enabled)', () => {
    expect(mount({ mfaEnabled: false }).component.mfaEnabled()).toBe(false);
    TestBed.resetTestingModule();
    expect(mount({ mfaEnabled: true }).component.mfaEnabled()).toBe(true);
  });

  it('Enable opens the enrolment wizard INSIDE the drawer (no navigation away)', () => {
    const { component, router } = mount({ mfaEnabled: false });
    expect(component.mfaSetupOpen()).toBe(false);
    component.enableMfa();
    // The operator stays on the Settings shell — the drawer just opens.
    expect(component.mfaSetupOpen()).toBe(true);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('openAdminMfaReset navigates to the admin MFA-reset route', () => {
    const { component, router } = mount();
    component.openAdminMfaReset();
    expect(router.navigate).toHaveBeenCalledWith(['/settings/admin-mfa-reset']);
  });

  // --- MFA enrolment wizard hosted in the Settings drawer ---

  it('onMfaSetupDone closes the drawer, lands on Security, and toasts the 2FA-scoped saved status', () => {
    const { component, router, toast } = mount({ mfaEnabled: false });
    component.enableMfa();
    component.mfaSetupDismissBlocked.set(true); // simulate the backup-step block being active
    component.onMfaSetupDone();
    expect(component.mfaSetupOpen()).toBe(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);
    expect(component.activeSection).toBe('security');
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'security' },
      replaceUrl: true,
    });
    expect(toast.success).toHaveBeenCalledWith('mfa.setup.securitySavedStatus');
  });

  it('closeMfaSetup (the cancel/Esc/scrim funnel) closes the drawer, lands on Security, toasts cancelled', () => {
    const { component, router, toast } = mount({ mfaEnabled: false });
    component.enableMfa();
    component.closeMfaSetup();
    expect(component.mfaSetupOpen()).toBe(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);
    expect(component.activeSection).toBe('security');
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'security' },
      replaceUrl: true,
    });
    expect(toast.info).toHaveBeenCalledWith('mfa.setup.securityCancelledStatus');
  });

  it('closeMfaSetup is a no-op when the drawer is already closed (no double toast/navigation)', () => {
    const { component, router, toast } = mount();
    component.closeMfaSetup(); // drawer never opened
    expect(router.navigate).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('abandons an open enrolment drawer when LEAVING Security: closed + cancelled toast, NO yank back', () => {
    const { component, router, toast } = mount({ mfaEnabled: false });
    component.selectSection('security');
    component.enableMfa();
    component.onMfaDismissBlockedChange(true); // simulate the backup-step block being active
    expect(component.mfaSetupOpen()).toBe(true);

    component.selectSection('appearance'); // the operator chose another tab

    // The drawer state is cleared through the SAME cancel funnel (info toast, nothing changed)…
    expect(component.mfaSetupOpen()).toBe(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith('mfa.setup.securityCancelledStatus');
    // …but WITHOUT navigating back: the chosen tab wins (no landOnSecurity()-style navigation).
    expect(component.activeSection).toBe('appearance');
    expect(router.navigate).not.toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'security' },
      replaceUrl: true,
    });
  });

  it('keeps the drawer closed on returning to Security after a tab switch abandoned the enrolment', () => {
    const { component } = mount({ mfaEnabled: false });
    component.selectSection('security');
    component.enableMfa();
    component.selectSection('appearance'); // abandons the open drawer

    component.selectSection('security'); // return

    // The stale `mfaSetupOpen` flag is gone, so the wizard does NOT silently re-open.
    expect(component.mfaSetupOpen()).toBe(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);
  });

  it('does NOT navigate to /settings/mfa anymore — the wizard is in-shell (no detached page)', () => {
    const { component, router } = mount({ mfaEnabled: false });
    component.enableMfa();
    expect(router.navigate).not.toHaveBeenCalledWith(['/settings/mfa']);
  });

  it('mirrors the wizard dismiss-block state for the drawer disableClose (security req B)', () => {
    const { component } = mount();
    expect(component.mfaSetupDismissBlocked()).toBe(false);
    component.onMfaDismissBlockedChange(true);
    expect(component.mfaSetupDismissBlocked()).toBe(true);
    component.onMfaDismissBlockedChange(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);
  });

  it('auto-opens the enrolment drawer on the /settings/mfa deep-link (route data.mfaAutoOpen)', () => {
    const { component } = mount({ mfaAutoOpen: true });
    component.ngOnInit();
    expect(component.activeSection).toBe('security');
    expect(component.mfaSetupOpen()).toBe(true);
  });

  it('does NOT auto-open the drawer on the plain /settings route (no mfaAutoOpen flag)', () => {
    const { component } = mount();
    component.ngOnInit();
    expect(component.mfaSetupOpen()).toBe(false);
  });

  it('keeps the regenerate lifecycle independent of the wizard drawer (no shared state)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    // Drive the SEPARATE regenerate flow.
    component.openMfaAction('regenerate');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '123456' });
    component.submitMfaAction();
    expect(component.mfaNewBackupCodes()).toEqual(['NEW1-NEW1', 'NEW2-NEW2']);
    expect(auth.mfaRegenerateBackupCodes).toHaveBeenCalled();

    // The wizard drawer is wholly untouched by the regenerate lifecycle.
    expect(component.mfaSetupOpen()).toBe(false);
    expect(component.mfaSetupDismissBlocked()).toBe(false);

    // And opening the wizard drawer does not disturb the regenerate signals.
    component.enableMfa();
    expect(component.mfaSetupOpen()).toBe(true);
    expect(component.mfaNewBackupCodes()).toEqual(['NEW1-NEW1', 'NEW2-NEW2']);
    expect(component.mfaAction()).toBe('regenerate');
  });

  it('opens the inline disable re-auth, then disables with password + code (AC6)', () => {
    const { component, auth, toast } = mount({ mfaEnabled: true });
    component.openMfaAction('disable');
    expect(component.mfaAction()).toBe('disable');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '123456' });
    component.submitMfaAction();
    expect(auth.mfaDisable).toHaveBeenCalledWith('Test-Passw0rd!', '123456');
    expect(component.mfaAction()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('mfa.settings.disabledToast');
  });

  it('does not submit a disable with a missing password or code', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    component.openMfaAction('disable');
    component.mfaReauthForm.setValue({ password: '', code: '123456' });
    component.submitMfaAction();
    expect(auth.mfaDisable).not.toHaveBeenCalled();
  });

  it('regenerate shows the new one-time backup codes; dismiss clears them (AC6)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    component.openMfaAction('regenerate');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '123456' });
    component.submitMfaAction();
    expect(auth.mfaRegenerateBackupCodes).toHaveBeenCalledWith('Test-Passw0rd!', '123456');
    expect(component.mfaNewBackupCodes()).toEqual(['NEW1-NEW1', 'NEW2-NEW2']);
    component.toggleMfaCodesSaved(); // tick the FE-04 "I have saved these" gate before dismissing
    component.dismissNewBackupCodes();
    expect(component.mfaNewBackupCodes()).toEqual([]);
    expect(component.mfaAction()).toBeNull();
  });

  it('surfaces a generic error key when a disable/regenerate action fails', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    auth.mfaDisable.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.openMfaAction('disable');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '000000' });
    component.submitMfaAction();
    expect(component.mfaErrorKey()).toBe('mfa.settings.actionError');
  });

  it('cancelMfaAction closes the inline form and clears its state', () => {
    const { component } = mount({ mfaEnabled: true });
    component.openMfaAction('regenerate');
    component.mfaReauthForm.setValue({ password: 'x', code: 'y' });
    component.cancelMfaAction();
    expect(component.mfaAction()).toBeNull();
    expect(component.mfaReauthForm.getRawValue()).toEqual({ password: '', code: '' });
  });

  // --- Security: Trusted devices ---

  it('lazily loads the trusted devices the first time the Security tab activates', () => {
    const { component, auth } = mount();
    expect(auth.mfaListDevices).not.toHaveBeenCalled(); // not loaded on Profile
    component.selectSection('security');
    expect(auth.mfaListDevices).toHaveBeenCalledTimes(1);
    expect(component.devices().map(d => d.id)).toEqual(['dev-1', 'dev-2']);
    expect(component.devicesLoading()).toBe(false);
  });

  it('does not reload devices on re-selecting the already-active Security tab (once per activation)', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    component.selectSection('security'); // idempotent re-select
    expect(auth.mfaListDevices).toHaveBeenCalledTimes(1);
  });

  it('re-arms the device load when leaving and returning to the Security tab', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    component.selectSection('appearance');
    component.selectSection('security');
    expect(auth.mfaListDevices).toHaveBeenCalledTimes(2);
  });

  it('renders the empty state when the operator has no trusted devices (feature off)', () => {
    const { component, auth } = mount();
    auth.mfaListDevices.mockReturnValueOnce(of([]));
    component.selectSection('security');
    expect(component.devices()).toEqual([]);
    expect(component.devicesErrorKey()).toBeNull();
  });

  it('surfaces an error key + clears loading when the device list fails to load', () => {
    const { component, auth } = mount();
    auth.mfaListDevices.mockReturnValueOnce(throwError(() => new Error('boom')));
    component.selectSection('security');
    expect(component.devicesErrorKey()).toBe('mfa.devices.errorBody');
    expect(component.devicesLoading()).toBe(false);
    expect(component.devices()).toEqual([]);
  });

  it('retryLoadDevices re-fetches the list after a failure', () => {
    const { component, auth } = mount();
    auth.mfaListDevices.mockReturnValueOnce(throwError(() => new Error('boom')));
    component.selectSection('security');
    expect(component.devicesErrorKey()).toBe('mfa.devices.errorBody');
    component.retryLoadDevices(); // mfaListDevices default returns the two devices again
    expect(auth.mfaListDevices).toHaveBeenCalledTimes(2);
    expect(component.devicesErrorKey()).toBeNull();
    expect(component.devices().map(d => d.id)).toEqual(['dev-1', 'dev-2']);
  });

  it('askRevoke opens the confirm dialog for a specific device; cancelRevoke closes it without revoking', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    component.askRevoke('dev-1');
    expect(component.confirmRevokeId()).toBe('dev-1');
    component.cancelRevoke();
    expect(component.confirmRevokeId()).toBeNull();
    expect(auth.mfaRevokeDevice).not.toHaveBeenCalled();
    expect(component.devices()).toHaveLength(2); // list untouched
  });

  it('optimistically removes the device on confirm and DELETEs it, then toasts success', () => {
    const { component, auth, toast } = mount();
    component.selectSection('security');
    component.askRevoke('dev-1');
    component.confirmRevoke();
    expect(auth.mfaRevokeDevice).toHaveBeenCalledWith('dev-1');
    expect(component.devices().map(d => d.id)).toEqual(['dev-2']); // dev-1 gone
    expect(component.confirmRevokeId()).toBeNull();
    expect(component.revokingId()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('mfa.devices.revokedToast');
  });

  it('rolls the device back to its original position and toasts an error when revoke fails', () => {
    const { component, auth, toast } = mount();
    component.selectSection('security');
    auth.mfaRevokeDevice.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 500 })),
    );
    component.askRevoke('dev-1');
    component.confirmRevoke();
    // dev-1 restored at index 0 (original order preserved), error surfaced.
    expect(component.devices().map(d => d.id)).toEqual(['dev-1', 'dev-2']);
    expect(toast.error).toHaveBeenCalledWith('mfa.devices.revokeError');
    expect(component.revokingId()).toBeNull();
  });

  it('treats a 404 on revoke as already-revoked: keeps the removal and toasts success (idempotent)', () => {
    const { component, auth, toast } = mount();
    component.selectSection('security');
    auth.mfaRevokeDevice.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 404 })),
    );
    component.askRevoke('dev-2');
    component.confirmRevoke();
    expect(component.devices().map(d => d.id)).toEqual(['dev-1']); // dev-2 stays gone
    expect(toast.success).toHaveBeenCalledWith('mfa.devices.revokedToast');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('ignores confirmRevoke when no device is pending', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    component.confirmRevoke(); // nothing queued
    expect(auth.mfaRevokeDevice).not.toHaveBeenCalled();
  });

  it('switches the visible section via the sub-nav', () => {
    const { component, router } = mount();
    component.selectSection('notifications');
    expect(component.activeSection).toBe('notifications');
    expect(router.navigate).toHaveBeenCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { section: 'notifications' },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  });

  it('deep-links to a valid section from the query string', () => {
    const { component } = mount({ section: 'appearance' });
    component.ngOnInit();
    expect(component.activeSection).toBe('appearance');
  });

  it('initialises themeChoice from the live theme', () => {
    expect(mount({ theme: 'dark' }).component.themeChoice).toBe('dark');
  });

  it('applies an explicit light/dark theme through the existing ThemeService', () => {
    const { component, theme } = mount();
    component.onThemeChange('dark');
    expect(component.themeChoice).toBe('dark');
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
  });

  it('resolves the "system" choice to light when the OS does not prefer dark', () => {
    // setup.ts stubs matchMedia to matches:false → light.
    const { component, theme } = mount();
    component.onThemeChange('system');
    expect(component.themeChoice).toBe('system');
    expect(theme.setTheme).toHaveBeenCalledWith('light');
  });

  it('resolves "system" to dark when the OS prefers dark', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    const { component, theme } = mount();
    component.onThemeChange('system');
    expect(theme.setTheme).toHaveBeenCalledWith('dark');
  });

  it('routes the density preference through DensityService (F4: it actually applies)', () => {
    const { component, density } = mount();
    expect(component.density()).toBe('comfortable');

    component.onDensityChange('compact');
    expect(density.setDensity).toHaveBeenCalledWith('compact');
    expect(component.density()).toBe('compact');

    component.onDensityChange('unknown');
    expect(density.setDensity).toHaveBeenCalledWith('comfortable');
  });

  it('reflects the current language from TranslateService', () => {
    expect(mount({ lang: 'tr' }).component.currentLang).toBe('tr');
    TestBed.resetTestingModule();
    expect(mount({ lang: 'en' }).component.currentLang).toBe('en');
  });

  it('switches language via TranslateService, persists `lang`, and toasts', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { component, i18n, toast } = mount();
    component.onLangChange('tr');
    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(setItem).toHaveBeenCalledWith('lang', 'tr');
    expect(toast.success).toHaveBeenCalledWith('settings.language.saved');
    setItem.mockRestore();
  });

  it('keeps the language switch usable when browser storage rejects the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const { component, i18n, toast } = mount();

    expect(() => component.onLangChange('tr')).not.toThrow();
    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(toast.success).toHaveBeenCalledWith('settings.language.saved');
    setItem.mockRestore();
  });

  it('keeps the language switch usable when browser storage is absent', () => {
    const originalStorage = globalThis.localStorage;
    const { component, i18n, toast } = mount();
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(() => component.onLangChange('tr')).not.toThrow();
    } finally {
      vi.stubGlobal('localStorage', originalStorage);
    }

    expect(i18n.use).toHaveBeenCalledWith('tr');
    expect(toast.success).toHaveBeenCalledWith('settings.language.saved');
  });

  it('falls back to English for an unknown language value', () => {
    const { component, i18n } = mount();
    component.onLangChange('xx');
    expect(i18n.use).toHaveBeenCalledWith('en');
  });

  it('A2: saveProfile blocks a PRISTINE form (no API call on an unedited profile)', () => {
    const { component, operator } = mount();
    component.profileForm.setValue({
      displayName: 'Op Name',
      email: 'op@example.com',
      phone: '',
      jobTitle: 'Analyst',
    });
    // No markAsDirty: programmatic values leave the form pristine, exactly like an unedited screen.
    component.saveProfile();
    expect(operator.updateProfile).not.toHaveBeenCalled();
  });

  it('A2: saveProfile blocks an INVALID form (empty required displayName)', () => {
    const { component, operator } = mount();
    component.profileForm.setValue({
      displayName: '',
      email: 'op@example.com',
      phone: '',
      jobTitle: '',
    });
    component.profileForm.markAsDirty();
    component.saveProfile();
    expect(operator.updateProfile).not.toHaveBeenCalled();
    expect(component.profileForm.touched).toBe(true); // errors are surfaced, not swallowed
  });

  it('A2: saveProfile blocks an invalid phone instead of silently stripping characters', () => {
    const { component, operator } = mount();
    component.profileForm.setValue({
      displayName: 'Op Name',
      email: 'op@example.com',
      phone: '+90 555',
      jobTitle: '',
    });
    component.profileForm.markAsDirty();
    component.saveProfile();
    expect(operator.updateProfile).not.toHaveBeenCalled();
    expect(component.profileForm.controls.phone.errors).toEqual({ phoneInvalid: true });
  });

  it('A2: mfa reauth blocks a too-short password (mirrors the BE MfaReauthDto)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    component.openMfaAction('disable');
    component.mfaReauthForm.setValue({ password: 'short', code: '123456' });
    component.submitMfaAction();
    expect(auth.mfaDisable).not.toHaveBeenCalled();
  });

  it('A2: mfa reauth accepts a backup-code-formatted code (XXXXX-XXXXX)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    component.openMfaAction('disable');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: 'ABCDE-12345' });
    component.submitMfaAction();
    expect(auth.mfaDisable).toHaveBeenCalledWith('Test-Passw0rd!', 'ABCDE-12345');
  });

  it('saves the profile through OperatorApi and says so (server-backed)', () => {
    const { component, operator, toast } = mount();
    component.profileForm.setValue({
      displayName: 'Op Name',
      email: 'op@example.com',
      phone: '+905551112233',
      jobTitle: 'Analyst',
    });
    component.profileForm.markAsDirty(); // A2: save is gated on an actually-edited form
    component.saveProfile();

    expect(component.profileForm.touched).toBe(true);
    expect(operator.updateProfile).toHaveBeenCalledWith({
      displayName: 'Op Name',
      phone: '+905551112233',
      jobTitle: 'Analyst',
    });
    expect(toast.success).toHaveBeenCalledWith('settings.savedServer');
  });

  it('loads the profile from OperatorApi on init', () => {
    const { component } = mount({
      profile: { displayName: 'Stored', email: 's@example.com', phone: null, jobTitle: 'Ops' },
    });
    component.ngOnInit();
    expect(component.profileForm.getRawValue()).toEqual({
      displayName: 'Stored',
      email: 's@example.com',
      phone: '',
      jobTitle: 'Ops',
    });
  });

  it('cancelProfile discards unsaved edits by reloading the canonical profile', () => {
    const { component, operator } = mount({
      profile: { displayName: 'Stored', email: 's@example.com', phone: null, jobTitle: 'Ops' },
    });
    component.ngOnInit();
    component.profileForm.controls.displayName.setValue('Unsaved');
    component.profileForm.markAsDirty();

    component.cancelProfile();

    expect(operator.getProfile).toHaveBeenCalledTimes(2);
    expect(component.profileForm.getRawValue()).toEqual({
      displayName: 'Stored',
      email: 's@example.com',
      phone: '',
      jobTitle: 'Ops',
    });
    expect(component.profileForm.pristine).toBe(true);
  });

  it('persists notification toggles through OperatorApi as they change', () => {
    const { component, operator } = mount();
    component.ngOnInit();

    component.notificationsForm.controls.weeklyDigest.setValue(true);
    expect(operator.updateNotificationPreferences).toHaveBeenLastCalledWith({
      productUpdates: true,
      securityAlerts: true,
      weeklyDigest: true,
    });

    component.notificationsForm.controls.productUpdates.setValue(false);
    expect(operator.updateNotificationPreferences).toHaveBeenLastCalledWith({
      productUpdates: false,
      securityAlerts: true,
      weeklyDigest: true,
    });
  });

  it('loads notification preferences from OperatorApi on init', () => {
    const { component } = mount({
      prefs: { productUpdates: false, securityAlerts: false, weeklyDigest: true },
    });
    component.ngOnInit();
    expect(component.notificationsForm.getRawValue()).toEqual({
      productUpdates: false,
      securityAlerts: false,
      weeklyDigest: true,
    });
  });

  it('ignores legacy localStorage settings and uses API values', () => {
    localStorage.setItem('settings.profile', 'not-json{');
    localStorage.setItem('settings.notifications', JSON.stringify(['array', 'not', 'object']));
    const { component } = mount();
    component.ngOnInit();
    expect(component.profileForm.getRawValue()).toEqual({
      displayName: '',
      email: 'operator@example.com',
      phone: '',
      jobTitle: '',
    });
    expect(component.notificationsForm.getRawValue()).toEqual({
      productUpdates: true,
      securityAlerts: true,
      weeklyDigest: false,
    });
  });

  it('keeps working when storage writes fail because profile save no longer uses storage', () => {
    const { component, toast } = mount();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    component.profileForm.controls.displayName.setValue('Memory Only');
    component.profileForm.markAsDirty(); // A2: save is gated on an actually-edited form
    expect(() => component.saveProfile()).not.toThrow();
    expect(toast.success).toHaveBeenCalledWith('settings.savedServer');
    setItem.mockRestore();
  });

  it('loads access health and shows only the active account permissions', () => {
    const { component, health, rbac } = mount();
    component.ngOnInit();
    component.selectSection('access');
    expect(health.getHealth).toHaveBeenCalled();
    expect(rbac.listRoles).not.toHaveBeenCalled();
    expect(rbac.listPermissions).not.toHaveBeenCalled();
    expect(component.health()?.status).toBe('ok');
    expect(component.accountPermissions()).toEqual(['roles.read']);
  });

  it('loads self-scoped access on a deep link without reading the global catalog', () => {
    const { component, health, rbac } = mount({ section: 'access' });
    component.ngOnInit();
    expect(component.activeSection).toBe('access');
    expect(health.getHealth).toHaveBeenCalled();
    expect(rbac.listRoles).not.toHaveBeenCalled();
    expect(rbac.listPermissions).not.toHaveBeenCalled();
  });

  // --- access derivation (self-scoped permissions grouped by resource) ---

  it('permissionGroups buckets the active account permissions by resource domain', () => {
    const { component } = mount({
      auth: ['customers.read', 'auth.mfa.admin_reset', 'customers.delete', 'kyc.read', ''],
    });
    const groups = component.permissionGroups();
    expect(groups.map(group => group.resource)).toEqual(['auth', 'customers', 'kyc', 'other']);
    // Codes within a group are sorted so the chip order is stable.
    expect(groups.find(group => group.resource === 'customers')?.items).toEqual([
      'customers.delete',
      'customers.read',
    ]);
  });

  it('accessRows tags each resource with its legend category and flags sensitive scopes', () => {
    const { component } = mount({
      auth: [
        'customers.read',
        'customers.pii.reveal',
        'wallets.manage-limits',
        'kyc.read',
        'auth.mfa.admin_reset',
      ],
    });
    const rows = component.accessRows();
    expect(rows.map(row => row.resource)).toEqual(['auth', 'customers', 'kyc', 'wallets']);
    expect(rows.find(row => row.resource === 'auth')?.category).toBe('identity');
    expect(rows.find(row => row.resource === 'customers')?.category).toBe('customer');
    expect(rows.find(row => row.resource === 'kyc')?.category).toBe('kyc');
    expect(rows.find(row => row.resource === 'wallets')?.category).toBe('financial');
    // Sensitive classification rides each scope chip (pii.reveal amber, plain read neutral).
    const customerScopes = rows.find(row => row.resource === 'customers')?.scopes ?? [];
    expect(
      customerScopes.map(scope => ({ action: scope.action, sensitive: scope.sensitive })),
    ).toEqual([
      { action: 'pii.reveal', sensitive: true },
      { action: 'read', sensitive: false },
    ]);
  });

  it('sensitiveCount counts only the classified-sensitive grants', () => {
    const { component } = mount({
      auth: ['customers.read', 'customers.delete', 'auth.password.admin_reset', 'roles.read'],
    });
    expect(component.sensitiveCount()).toBe(2);
  });

  it('uptimeParts stays null until health loads, then splits uptime into hours + minutes', () => {
    const { component } = mount({ health: { status: 'ok', uptimeSeconds: 20_880 } });
    expect(component.uptimeParts()).toBeNull(); // access not activated → health not fetched
    component.selectSection('access');
    expect(component.uptimeParts()).toEqual({ hours: 5, minutes: 48 });
  });

  it('initials derive from the live display name and fall back to the email first letter', () => {
    const { component } = mount();
    component.ngOnInit(); // profile mock: displayName null, email operator@example.com → 'O'
    expect(component.initials()).toBe('O');
    component.profileForm.controls.displayName.setValue('Local Administrator');
    expect(component.initials()).toBe('LA');
  });

  it('initials fall back to the neutral dot when both name and email are blank', () => {
    const { component } = mount({
      profile: { displayName: '', email: '', phone: null, jobTitle: null },
    });
    component.ngOnInit();
    expect(component.initials()).toBe('•');
  });

  it('lastLoginAt surfaces the principal sign-in stamp for the header chip', () => {
    const { component } = mount({ lastLogin: '2026-07-06T06:12:00.000Z' });
    expect(component.lastLoginAt()).toBe('2026-07-06T06:12:00.000Z');
  });

  it('lastLoginAt is null (chip hidden) when the payload lacks the field', () => {
    const { component } = mount();
    expect(component.lastLoginAt()).toBeNull();
  });

  it('activeSectionIcon fronts the mobile picker with the active section icon', () => {
    const { component } = mount();
    expect(component.activeSectionIcon()).toBe('ri-user-line'); // profile default
    component.selectSection('access');
    expect(component.activeSectionIcon()).toBe('ri-key-2-line');
  });

  it('toggleMobileNav flips the disclosure state', () => {
    const { component } = mount();
    expect(component.mobileNavOpen()).toBe(false);
    component.toggleMobileNav();
    expect(component.mobileNavOpen()).toBe(true);
    component.toggleMobileNav();
    expect(component.mobileNavOpen()).toBe(false);
  });

  it('onTabClick activates the section through the funnel and collapses the mobile menu', () => {
    const { component } = mount();
    component.mobileNavOpen.set(true);
    component.onTabClick('appearance');
    expect(component.activeSection).toBe('appearance');
    expect(component.mobileNavOpen()).toBe(false);
  });

  it('activeSectionLabelKey names the active section for the mobile trigger', () => {
    const { component } = mount();
    expect(component.activeSectionLabelKey()).toBe('settings.sections.profile');
    component.selectSection('access');
    expect(component.activeSectionLabelKey()).toBe('settings.sections.access');
  });

  // --- audit 9C: roving tablist keyboard nav, focus, and the access error path ---

  it('exposes stable tab/panel ids and the active section index', () => {
    const { component } = mount();
    expect(component.tabId('appearance')).toBe('settings-tab-appearance');
    expect(component.panelId('appearance')).toBe('settings-panel-appearance');
    expect(component.activeIndex()).toBe(0); // profile
    // Sections: profile(0) security(1) appearance(2) language(3) notifications(4) access(5).
    component.selectSection('language');
    expect(component.activeIndex()).toBe(3);
  });

  it('onTabKeydown roves with wrap (arrows), jumps (Home/End), and ignores other keys', () => {
    const { component } = mount();
    // 6 sections now: profile(0) security(1) appearance(2) language(3) notifications(4) access(5).
    const last = component.sections.length - 1;
    const press = (key: string, index: number) => {
      const e = new KeyboardEvent('keydown', { key });
      const prevented = vi.spyOn(e, 'preventDefault');
      component.onTabKeydown(e, index);
      return prevented;
    };

    press('ArrowUp', 0); // wraps to the last section
    expect(component.activeSection).toBe('access');
    press('ArrowDown', last); // wraps to the first
    expect(component.activeSection).toBe('profile');
    press('End', 0);
    expect(component.activeSection).toBe('access');
    press('Home', last);
    expect(component.activeSection).toBe('profile');
    press('ArrowRight', 0);
    expect(component.activeSection).toBe('security');
    press('ArrowLeft', 1);
    expect(component.activeSection).toBe('profile');

    const ignored = press('a', 0); // an unrelated key is a no-op
    expect(ignored).not.toHaveBeenCalled();
    expect(component.activeSection).toBe('profile');
  });

  it('moves DOM focus to the activated tab on the microtask', async () => {
    const { component } = mount();
    const el = document.createElement('button');
    // ArrowDown from index 0 (profile) now activates security (index 1).
    el.id = component.tabId('security');
    document.body.appendChild(el);
    const focusSpy = vi.spyOn(el, 'focus');

    component.onTabKeydown(new KeyboardEvent('keydown', { key: 'ArrowDown' }), 0); // → security
    await Promise.resolve();

    expect(focusSpy).toHaveBeenCalled();
    el.remove();
  });

  it('keyboard tab activation tolerates an unavailable document while focusing', async () => {
    const { component } = mount();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const originalDocument = globalThis.document;

    vi.stubGlobal('document', undefined);
    try {
      component.onTabKeydown(event, 0);
      await Promise.resolve();
    } finally {
      vi.stubGlobal('document', originalDocument);
    }

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(component.activeSection).toBe('security');
  });

  it('flags accessLoadFailed when the access-overview APIs error', () => {
    const { component, health } = mount();
    health.getHealth.mockReturnValueOnce(throwError(() => new Error('boom')));
    component.ngOnInit();
    component.selectSection('access');
    expect(component.accessLoadFailed()).toBe(true);
    expect(component.accessLoading()).toBe(false);
  });

  // --- coverage round: reveal timer, identity mirror, prefersDark guard, MFA + revoke edge branches ---

  it('reveals the UI after the skeleton beat (timer 800)', () => {
    vi.useFakeTimers();
    const { component } = mount();
    component.ngOnInit();
    expect(component.ready()).toBe(false);
    vi.advanceTimersByTime(800);
    expect(component.ready()).toBe(true);
    vi.useRealTimers();
  });

  it('keeps the identity band live as the operator edits the profile form (valueChanges → syncIdentity)', () => {
    const { component } = mount();
    component.ngOnInit();
    // A live edit (emitEvent default) flows through profileForm.valueChanges → syncIdentity().
    component.profileForm.controls.displayName.setValue('Live Edit');
    component.profileForm.controls.jobTitle.setValue('Compliance Officer');
    expect(component.identity()).toEqual({
      displayName: 'Live Edit',
      jobTitle: 'Compliance Officer',
      email: 'operator@example.com',
    });
  });

  it('saveProfile keeps the server-returned displayName/jobTitle (the ?? "" left arm)', () => {
    const { component, operator } = mount({
      profile: {
        displayName: 'Stored Name',
        email: 'op@example.com',
        phone: null,
        jobTitle: 'Ops',
      },
    });
    // updateProfile echoes non-null displayName/jobTitle, so the `?? ''` fallbacks take their left arm.
    component.profileForm.setValue({
      displayName: 'Stored Name',
      email: 'op@example.com',
      phone: '+905551112233',
      jobTitle: 'Ops',
    });
    component.profileForm.markAsDirty(); // A2: save is gated on an actually-edited form
    component.saveProfile();
    expect(operator.updateProfile).toHaveBeenCalled();
    expect(component.profileForm.getRawValue()).toEqual({
      displayName: 'Stored Name',
      email: 'op@example.com',
      phone: '+905551112233',
      jobTitle: 'Ops',
    });
    expect(component.identity().displayName).toBe('Stored Name');
  });

  it('saveProfile falls back to blank optional profile fields when the server returns nulls', () => {
    const { component, operator } = mount();
    operator.updateProfile.mockReturnValueOnce(
      of({
        displayName: null,
        email: 'op@example.com',
        phone: null,
        jobTitle: null,
      }),
    );
    component.profileForm.setValue({
      displayName: 'Temporary Name',
      email: 'op@example.com',
      phone: '+905551112233',
      jobTitle: 'Temporary Role',
    });
    component.profileForm.markAsDirty();

    component.saveProfile();

    expect(component.profileForm.getRawValue()).toEqual({
      displayName: '',
      email: 'op@example.com',
      phone: '',
      jobTitle: '',
    });
    expect(component.identity()).toEqual({
      displayName: '',
      email: 'op@example.com',
      jobTitle: '',
    });
  });

  it('resolves the system theme to light when window is unavailable (SSR-safe prefersDark guard)', () => {
    const { component, theme } = mount();
    const original = globalThis.window;
    // Remove `window` so prefersDark() hits the `typeof window === "undefined"` arm → light.
    vi.stubGlobal('window', undefined);
    try {
      component.onThemeChange('system');
      expect(theme.setTheme).toHaveBeenCalledWith('light');
    } finally {
      vi.stubGlobal('window', original);
    }
  });

  it('resolves the system theme to light when matchMedia throws (prefersDark catch arm)', () => {
    const { component, theme } = mount();
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('matchMedia unavailable');
    });
    component.onThemeChange('system');
    // The try/catch swallows the throw and falls back to light.
    expect(theme.setTheme).toHaveBeenCalledWith('light');
  });

  it('submitMfaAction is a no-op when no MFA action is open (the !action guard)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    // No openMfaAction() first → mfaAction() is null → submit returns immediately.
    component.submitMfaAction();
    expect(auth.mfaDisable).not.toHaveBeenCalled();
    expect(auth.mfaRegenerateBackupCodes).not.toHaveBeenCalled();
    expect(component.mfaSubmitting()).toBe(false);
  });

  it('surfaces the generic error key when REGENERATE fails (separate error arm from disable)', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    auth.mfaRegenerateBackupCodes.mockReturnValueOnce(throwError(() => ({ status: 401 })));
    component.openMfaAction('regenerate');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '000000' });
    component.submitMfaAction();
    expect(component.mfaErrorKey()).toBe('mfa.settings.actionError');
    expect(component.mfaNewBackupCodes()).toEqual([]);
  });

  it('dismissNewBackupCodes is gated: it does nothing until the "I have saved these" box is ticked', () => {
    const { component, auth } = mount({ mfaEnabled: true });
    component.openMfaAction('regenerate');
    component.mfaReauthForm.setValue({ password: 'Test-Passw0rd!', code: '123456' });
    component.submitMfaAction();
    expect(component.mfaNewBackupCodes()).toEqual(['NEW1-NEW1', 'NEW2-NEW2']);
    expect(auth.mfaRegenerateBackupCodes).toHaveBeenCalled();

    // Not yet confirmed → dismiss is a no-op (the codes stay on screen, no silent loss).
    component.dismissNewBackupCodes();
    expect(component.mfaNewBackupCodes()).toEqual(['NEW1-NEW1', 'NEW2-NEW2']);
  });

  it('cancelRevoke is blocked while a revoke is in flight (keeps the dialog state consistent)', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    // A revoke that never settles keeps revokingId set, so cancelRevoke must not clear the dialog.
    auth.mfaRevokeDevice.mockReturnValueOnce(NEVER);
    component.askRevoke('dev-1');
    component.confirmRevoke();
    expect(component.revokingId()).toBe('dev-1');

    component.cancelRevoke();
    // The guard `if (this.revokingId()) return` keeps the pending id rather than closing mid-flight.
    expect(component.confirmRevokeId()).toBe('dev-1');
  });

  it('confirmRevoke is a no-op when the pending id is no longer in the list (index === -1)', () => {
    const { component, auth } = mount();
    component.selectSection('security');
    // Queue a device id that is not in the loaded list → the findIndex === -1 guard closes the dialog
    // without any optimistic removal or DELETE.
    component.confirmRevokeId.set('ghost-device');
    component.confirmRevoke();
    expect(auth.mfaRevokeDevice).not.toHaveBeenCalled();
    expect(component.confirmRevokeId()).toBeNull();
    expect(component.devices().map(d => d.id)).toEqual(['dev-1', 'dev-2']); // list untouched
  });

  it('routes to the admin password reset and the notification history from settings actions', () => {
    const { component, router } = mount();
    component.openAdminPasswordReset();
    component.goToNotifications();
    expect(router.navigate).toHaveBeenCalledWith(['/admin-password-reset']);
    expect(router.navigate).toHaveBeenCalledWith(['/notifications']);
  });

  it('does not read the global role/permission catalog for operators without roles.read', () => {
    const { component, rbac, health } = mount({ auth: ['customers.read'] }); // no roles.read
    component.ngOnInit();
    component.selectSection('access');
    // Access is self-scoped: health can load, but global RBAC catalog endpoints must stay untouched.
    expect(rbac.listRoles).not.toHaveBeenCalled();
    expect(rbac.listPermissions).not.toHaveBeenCalled();
    expect(health.getHealth).toHaveBeenCalled();
    expect(component.accountPermissions()).toEqual(['customers.read']);
    expect(component.accessLoadFailed()).toBe(false);
  });
});
