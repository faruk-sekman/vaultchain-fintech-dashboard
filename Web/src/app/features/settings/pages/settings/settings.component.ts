/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { of, timer } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';

import { HttpErrorResponse } from '@angular/common/http';

import { HealthApi, HealthStatus } from '@core/api/health.api';
import type { RememberedDevice } from '@core/api/mfa.api';
import { OperatorApi } from '@core/api/operator.api';
import { AuthService } from '@core/auth/auth.service';
import { DensityService, DensityMode } from '@core/services/density.service';
import { ThemeService, ResolvedTheme } from '@core/services/theme.service';
import { ToastService } from '@core/services/toast.service';
import { UiDrawerComponent } from '@shared/components/ui-drawer/ui-drawer.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { UiTabItem } from '@shared/components/ui-tabs/ui-tabs.component';
import { UiSegmentItem } from '@shared/components/ui-segmented/ui-segmented.component';
import { phoneNumberValidator } from '@shared/validators/custom.validators';
import { MfaSetupWizardComponent } from '../../components/mfa-setup-wizard/mfa-setup-wizard.component';
import { SettingsAccessPanelComponent } from '../../components/settings-access-panel/settings-access-panel.component';
import { SettingsAppearancePanelComponent } from '../../components/settings-appearance-panel/settings-appearance-panel.component';
import { SettingsLanguagePanelComponent } from '../../components/settings-language-panel/settings-language-panel.component';
import { SettingsNotificationsPanelComponent } from '../../components/settings-notifications-panel/settings-notifications-panel.component';
import { SettingsProfilePanelComponent } from '../../components/settings-profile-panel/settings-profile-panel.component';
import { SettingsSecurityPanelComponent } from '../../components/settings-security-panel/settings-security-panel.component';
import {
  AppLang,
  LANG_STORAGE_KEY,
  SettingsSection,
  ThemeChoice,
} from '../../models/settings.models';
import { SettingsAccessService } from '../../services/settings-access.service';

/**
 * Tab item narrowed for this screen: every settings tab is declared with a section value, a label
 * key, and an icon, so the active-tab lookups need no defensive fallbacks (see {@link SettingsComponent#activeTab}).
 */
interface SettingsTabItem extends UiTabItem {
  value: SettingsSection;
  labelKey: string;
  icon: string;
}

/**
 * Settings screen (`/settings`, v2 §5). Single white card with underline tabs
 * (Profile / Appearance / Language / Notifications); the header shell owns the H1.
 *
 * Persistence:
 *  - Theme light/dark → existing {@link ThemeService} (`localStorage['theme']`).
 *  - Language EN/TR → existing `TranslateService.use()` + `localStorage['lang']`.
 *  - Density → {@link DensityService} (`localStorage['density']`, F4) — applied for
 *    real by table screens via the `ui-table` `density` input.
 *  - Profile (F3) + Notifications (F2) → backend operator API.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiDrawerComponent,
    UiSkeletonComponent,
    MfaSetupWizardComponent,
    SettingsAccessPanelComponent,
    SettingsAppearancePanelComponent,
    SettingsLanguagePanelComponent,
    SettingsNotificationsPanelComponent,
    SettingsProfilePanelComponent,
    SettingsSecurityPanelComponent,
  ],
  templateUrl: './settings.component.html',
  // Default Emulated encapsulation: this stylesheet owns ONLY the shell chrome; each section panel
  // owns its own styles (plus the shared `components/_settings-panel.shared.scss` partial).
  styleUrl: './settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent implements OnInit {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly themeService = inject(ThemeService);
  private readonly densityService = inject(DensityService);
  private readonly i18n = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly healthApi = inject(HealthApi);
  private readonly operatorApi = inject(OperatorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly settingsAccess = inject(SettingsAccessService);
  /** Defense-in-depth RBAC gate: the access (roles/permissions) section needs `roles.read`. */
  protected readonly auth = inject(AuthService);

  /** Which section is visible. Local view state only — never persisted. */
  activeSection: SettingsSection = 'profile';

  /** All underline-tab items (F1: no Security tab); `sections` filters this by permission. */
  private readonly allSections: ReadonlyArray<SettingsTabItem> = [
    { value: 'profile', labelKey: 'settings.sections.profile', icon: 'ri-user-line' },
    // Re-introduced (vs gap-analysis F1) now that MFA is a REAL backend-backed control —
    // not the pretend 2FA/session toggles that were removed. Universal: every operator self-manages.
    { value: 'security', labelKey: 'settings.sections.security', icon: 'ri-shield-keyhole-line' },
    { value: 'appearance', labelKey: 'settings.sections.appearance', icon: 'ri-palette-line' },
    { value: 'language', labelKey: 'settings.sections.language', icon: 'ri-translate-2' },
    {
      value: 'notifications',
      labelKey: 'settings.sections.notifications',
      icon: 'ri-notification-3-line',
    },
    { value: 'access', labelKey: 'settings.sections.access', icon: 'ri-key-2-line' },
  ];

  /** Tabs visible to the current operator. Access is self-scoped, so every signed-in operator can view it. */
  get sections(): ReadonlyArray<SettingsTabItem> {
    return this.allSections;
  }

  // --- Appearance: theme + density --------------------------------------------
  /** Reactive readout of the live theme; OnPush re-renders when it changes. */
  readonly theme = this.themeService.theme;
  /** Tracks the chosen control value separately so `system` survives the round-trip. */
  themeChoice: ThemeChoice = this.theme();

  readonly themeOptions: ReadonlyArray<UiSegmentItem> = [
    { value: 'light', labelKey: 'settings.appearance.theme.light', icon: 'ri-sun-line' },
    { value: 'dark', labelKey: 'settings.appearance.theme.dark', icon: 'ri-moon-line' },
    { value: 'system', labelKey: 'settings.appearance.theme.system', icon: 'ri-computer-line' },
  ];

  /** Density preference (F4): persisted via DensityService and applied by table screens. */
  readonly density = this.densityService.density;
  readonly densityOptions: ReadonlyArray<UiSegmentItem> = [
    { value: 'comfortable', labelKey: 'settings.appearance.density.comfortable' },
    { value: 'compact', labelKey: 'settings.appearance.density.compact' },
  ];

  // --- Language ----------------------------------------------------------------
  readonly langOptions: ReadonlyArray<UiSegmentItem> = [
    { value: 'en', label: 'English' },
    { value: 'tr', label: 'Türkçe' },
  ];

  // --- Profile form (F3: device-local persistence) -----------------------------
  // A2: validators mirror the BE UpdateOperatorProfileDto (displayName @Length(1,120),
  // jobTitle @MaxLength(80)) so the FE never submits what the BE would 400.
  readonly profileForm = new FormGroup({
    displayName: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(120)],
    }),
    email: new FormControl<string>('', { nonNullable: true }),
    phone: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.maxLength(32), phoneNumberValidator()],
    }),
    jobTitle: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.maxLength(80)],
    }),
  });

  // --- Notifications form (F2: device-local persistence) -----------------------
  readonly notificationsForm = new FormGroup({
    productUpdates: new FormControl<boolean>(true, { nonNullable: true }),
    securityAlerts: new FormControl<boolean>(true, { nonNullable: true }),
    weeklyDigest: new FormControl<boolean>(false, { nonNullable: true }),
  });

  /**
   * Read-only mirror of the profile fields for the gradient identity band. Held as a
   * signal (not a direct `profileForm.value` template read) so the OnPush band re-renders
   * when the profile loads (patched with `emitEvent: false`, which skips `valueChanges`),
   * saves, or is edited live. Display-only: it changes nothing about how the form persists.
   */
  readonly identity = signal<{ displayName: string; jobTitle: string; email: string }>({
    displayName: '',
    jobTitle: '',
    email: '',
  });

  /**
   * Identity-band "Role" chip value — derived from the REAL granted permission set (never a fabricated
   * label), mirroring the seeded role→permission matrix: `roles.manage` is held ONLY by the
   * administrator, `customers.manage` marks the day-to-day operator (Compliance Officer), and a purely
   * read-only grant is the auditor (Viewer). `roles.read` is NOT a discriminator — every role holds it,
   * which is why it previously mislabeled everyone as administrator. Reuses the login role-card labels
   * so the chip matches the role name the operator signed in with, fails closed to the least-privileged
   * label until the principal loads, and stays OnPush-reactive via the permission computed.
   */
  readonly identityRoleKey = computed(() => {
    if (this.auth.hasPermission('roles.manage')) return 'auth.login.demo.roles.administrator.name';
    if (this.auth.hasPermission('customers.manage')) return 'auth.login.demo.roles.operator.name';
    return 'auth.login.demo.roles.auditor.name';
  });

  /**
   * Account-header avatar initials from the LIVE display name (first + last word, e.g.
   * "Local Administrator" → "LA"); falls back to the email's first letter, then a neutral dot.
   * Reads {@link identity} so live profile edits update the avatar too.
   */
  readonly initials = computed(() => {
    const name = this.identity().displayName.trim();
    if (name) {
      const parts = name.split(/\s+/).filter(Boolean);
      const first = parts[0]?.charAt(0) ?? '';
      const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
      return (first + last).toUpperCase() || '•';
    }
    return (this.identity().email.charAt(0) || '•').toUpperCase();
  });

  /**
   * ISO time of the sign-in that issued this session (the backend stamps `lastLoginAt` at login,
   * before the session response is built). Null before the principal loads or on legacy payloads
   * without the field — the header chip simply hides then (never a fabricated timestamp).
   */
  readonly lastLoginAt = computed(() => this.auth.principal()?.user.lastLoginAt ?? null);

  // --- Security: MFA card -----------------------------
  /** Live MFA-enabled state, read from the principal (`/auth/me` includes `mfaEnabled`). */
  readonly mfaEnabled = this.auth.mfaEnabled;
  /** Which inline re-auth flow is open in the card, if any. */
  readonly mfaAction = signal<'disable' | 'regenerate' | null>(null);
  readonly mfaSubmitting = signal(false);
  readonly mfaErrorKey = signal<string | null>(null);
  /** Newly-issued backup codes after a regenerate — shown ONCE, cleared on leave/close. */
  readonly mfaNewBackupCodes = signal<readonly string[]>([]);
  /** Explicit "I have saved these" gate before the regenerated codes can be dismissed (no silent loss). */
  readonly mfaCodesSaved = signal(false);

  /**
   * The MFA enrolment wizard opens in the page-owned `app-ui-drawer`, hosted outside the animated
   * settings shell so the fixed scrim covers the viewport. Closing the drawer DESTROYS the wizard
   * instance — its `ngOnDestroy` GCs the transient QR/backup-code signals. This drawer state is
   * wholly separate from the regenerate lifecycle (`mfaAction`/`mfaNewBackupCodes`/`mfaCodesSaved`)
   * above; the two never share state.
   */
  readonly mfaSetupOpen = signal(false);
  /**
   * Host-side mirror of the wizard's `dismissBlocked()` (security req B), updated via the wizard's
   * `dismissBlockedChange` output. Drives the drawer's `[disableClose]` so a stray Esc/scrim cannot
   * discard the one-time backup codes before "I have saved these" is ticked. This is the host's own
   * derived UI flag — it shares no state with the wizard's internal signals.
   */
  readonly mfaSetupDismissBlocked = signal(false);

  /** Re-auth inputs the disable/regenerate endpoints require (password + a TOTP/backup code). */
  // A2: mirrors the BE MfaReauthDto (password 8-128; code = 6-digit TOTP OR XXXXX-XXXXX backup).
  readonly mfaReauthForm = new FormGroup({
    password: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(8), Validators.maxLength(128)],
    }),
    code: new FormControl<string>('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/),
      ],
    }),
  });

  // --- Security: Trusted devices ------------------
  /**
   * The operator's active "remember this device" records. The backend is the sole authority (no
   * localStorage); the list is empty whenever the remember-device feature is off, which is exactly the
   * empty state the card renders. Loaded lazily on each Security-tab activation.
   */
  readonly devices = signal<readonly RememberedDevice[]>([]);
  readonly devicesLoading = signal(false);
  /** Translate key for a load failure (drives the error+retry block); null when there's nothing wrong. */
  readonly devicesErrorKey = signal<string | null>(null);
  /** The device id whose revoke is currently in flight (disables just that row's button). */
  readonly revokingId = signal<string | null>(null);
  /** The device id pending confirmation in the shared confirm dialog (null = dialog closed). */
  readonly confirmRevokeId = signal<string | null>(null);

  readonly accessLoading = signal(false);
  readonly accessLoadFailed = signal(false);
  readonly health = signal<HealthStatus | null>(null);

  /** Permission codes granted to the currently signed-in account; never the global role catalog. */
  readonly accountPermissions = computed(() =>
    [...(this.auth.principal()?.permissions ?? [])].sort((a, b) => a.localeCompare(b)),
  );

  /** Current account's permission set grouped by resource domain (code prefix before the first dot). */
  readonly permissionGroups = computed(() =>
    this.settingsAccess.groupPermissions(this.accountPermissions()),
  );

  readonly accountResourceCount = computed(() => this.permissionGroups().length);

  /**
   * The access table's rows: {@link permissionGroups} enriched with the legend category and, per
   * scope, the action segment + the sensitive flag. Pure derivation of the live principal — the
   * table reviews what THIS session can actually do, never a fabricated catalog.
   */
  readonly accessRows = computed(() => this.settingsAccess.toAccessRows(this.permissionGroups()));

  /** Count of granted codes classified sensitive — the aside's amber "audited grants" readout. */
  readonly sensitiveCount = computed(() =>
    this.settingsAccess.sensitiveCount(this.accountPermissions()),
  );

  /** Legend rows for the aside (static order; labels resolve via i18n). */
  readonly accessCategories = this.settingsAccess.categories;

  /** API uptime split into hours + minutes for the aside readout; null until health loads. */
  readonly uptimeParts = computed(() => {
    const seconds = this.health()?.uptimeSeconds;
    if (seconds === undefined || seconds === null) return null;
    return { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) };
  });

  /**
   * First-paint reveal gate (UX choreography, not a data flag): the screen shows a skeleton
   * shell, then flips to the real nav + panel with a staggered entrance. The initial data
   * loads run concurrently and have settled (or show their own loading state) by reveal.
   */
  readonly ready = signal(false);
  /** Loop seeds for the skeleton shell (one per section tab; three placeholder rows). */
  readonly skeletonTabs = [0, 1, 2, 3, 4, 5] as const;
  readonly skeletonRows = [0, 1, 2] as const;

  ngOnInit(): void {
    this.loadProfile();
    this.loadNotificationPreferences();

    // Reveal the real UI after a short skeleton beat so the entrance animation reads; the
    // concurrent loads above resolve within (or keep their own loading state past) this window.
    timer(800)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.ready.set(true));

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const section = params.get('section');
      if (this.isSettingsSection(section) && this.canViewSection(section)) {
        this.setActiveSection(section);
      }
    });

    // The preserved `/settings/mfa` deep-link resolves to THIS Settings shell with
    // `data.mfaAutoOpen` set. On direct nav / bookmark / refresh, land on Security and auto-open the
    // enrolment drawer on the password step. The drawer's own `@if (mfaSetupOpen())` mounts a fresh
    // wizard (seed null; mfaSetupStart is NOT called until the password is submitted), preserving the
    // re-auth gate. `data` is read reactively so a Back/Forward into the route re-triggers cleanly.
    this.route.data.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(data => {
      if (data['mfaAutoOpen'] === true) {
        this.setActiveSection('security');
        this.mfaSetupOpen.set(true);
      }
    });

    // Switches act immediately (design-system switch semantics): every toggle is
    // persisted to the backend right away, with no inactive "Save" affordance in between.
    this.notificationsForm.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.saveNotificationPreferences());

    // Keep the identity band live as the operator edits their profile. Load/save use
    // `emitEvent: false`, so those paths call `syncIdentity()` directly (see below).
    this.profileForm.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.syncIdentity());
  }

  /** Mirror the current profile field values into the identity-band signal. */
  private syncIdentity(): void {
    const value = this.profileForm.getRawValue();
    this.identity.set({
      displayName: value.displayName,
      jobTitle: value.jobTitle,
      email: value.email,
    });
  }

  selectSection(section: string): void {
    if (!this.isSettingsSection(section) || !this.canViewSection(section)) return;
    this.setActiveSection(section);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { section },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Single funnel for activating a section (deep-link OR tab click): updates the visible section and
   * fires per-activation side effects. A no-op when the section hasn't actually changed, so it never
   * re-loads on an idempotent re-selection; Security and Access (re)load their data on every real
   * entry, so a later return always shows a fresh list. (The old `*LoadedForActivation` entry guards
   * were provably constant — they were only ever cleared by leaving the section — and were removed
   * as dead state.)
   */
  private setActiveSection(section: SettingsSection): void {
    if (section === this.activeSection) return;
    // Leaving Security while the enrolment drawer is open abandons the enrolment through the SAME
    // state-clearing funnel as Cancel/Esc — WITHOUT navigating (the operator chose another tab).
    // The drawer is page-owned, so clear it explicitly instead of letting it float over another tab.
    if (this.activeSection === 'security' && this.mfaSetupOpen()) {
      this.abandonMfaSetup();
    }
    this.activeSection = section;
    if (section === 'security') this.loadDevices();
    if (section === 'access') this.loadAccessOverview();
  }

  // --- Section tablist (custom nav; ARIA "Tabs" pattern) -----------------------
  /** Stable id for a tab button — paired 1:1 with {@link panelId} for aria-controls/labelledby. */
  tabId(section: string): string {
    return `settings-tab-${section}`;
  }

  /** Stable id for the panel a tab controls. */
  panelId(section: string): string {
    return `settings-panel-${section}`;
  }

  /** Index of the active section — drives the sliding nav indicator (`--settings-nav-active`). */
  activeIndex(): number {
    return this.sections.findIndex(s => s.value === this.activeSection);
  }

  /**
   * The active section's tab item. `allSections` declares an entry for every {@link SettingsSection}
   * (exhaustive by construction) and `activeSection` is typed to that union, so the lookup cannot
   * miss — asserted rather than guarded (unreachable fallback arms are deleted, not pretend-tested).
   */
  private activeTab(): SettingsTabItem {
    return this.sections.find(s => s.value === this.activeSection)!;
  }

  /** Icon of the active section — fronts the mobile menu trigger so the current place reads at a glance. */
  activeSectionIcon(): string {
    return this.activeTab().icon;
  }

  /** Label key of the active section — the mobile trigger names where you are. */
  activeSectionLabelKey(): string {
    return this.activeTab().labelKey;
  }

  /**
   * Mobile nav disclosure (≤768px): the trigger button toggles the tablist open as a stacked menu
   * panel. Desktop ignores this state entirely (the row is always visible there via CSS).
   */
  readonly mobileNavOpen = signal(false);

  toggleMobileNav(): void {
    this.mobileNavOpen.update(open => !open);
  }

  /** Tab activation → the same section funnel, then collapse the mobile menu (a menu closes on pick). */
  onTabClick(section: string): void {
    this.selectSection(section);
    this.mobileNavOpen.set(false);
  }

  /**
   * Roving tablist keyboard nav (WAI-ARIA APG): Up/Down (and Left/Right) move with wrap,
   * Home/End jump to the ends, and movement activates the section (automatic activation,
   * matching the prior `ui-tabs` behaviour). Focus follows selection.
   */
  onTabKeydown(event: KeyboardEvent, index: number): void {
    const count = this.sections.length;
    let next = index;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (index + 1) % count;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (index - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const value = this.sections[next].value;
    this.selectSection(value);
    queueMicrotask(() => this.focusTab(value));
  }

  private focusTab(value: string): void {
    if (typeof document === 'undefined') return;
    document.getElementById(this.tabId(value))?.focus();
  }

  // --- Appearance handlers -----------------------------------------------------
  onThemeChange(value: string): void {
    const choice = value as ThemeChoice;
    this.themeChoice = choice;
    this.themeService.setTheme(this.resolveTheme(choice));
  }

  /**
   * Map a {@link ThemeChoice} to a concrete mode the existing service understands.
   * `system` resolves the current OS preference at apply time. The service has no
   * persisted `system` mode, so the choice is applied live but is not remembered as
   * `system` across reloads. A future ThemeService extension can persist a
   * system-following preference and react to `prefers-color-scheme` changes.
   */
  private resolveTheme(choice: ThemeChoice): ResolvedTheme {
    if (choice !== 'system') return choice;
    return this.prefersDark() ? 'dark' : 'light';
  }

  private prefersDark(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  }

  /** F4: density now actually persists and is applied by every `ui-table` screen. */
  onDensityChange(value: string): void {
    const density: DensityMode = value === 'compact' ? 'compact' : 'comfortable';
    this.densityService.setDensity(density);
  }

  // --- Language handler --------------------------------------------------------
  get currentLang(): AppLang {
    return this.i18n.currentLang === 'tr' ? 'tr' : 'en';
  }

  onLangChange(value: string): void {
    const lang: AppLang = value === 'tr' ? 'tr' : 'en';
    // Reuse the exact mechanism the header uses: switch ngx-translate + persist `lang`.
    this.i18n.use(lang);
    this.persistLang(lang);
    this.toast.success(this.i18n.instant('settings.language.saved'));
  }

  private persistLang(lang: AppLang): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LANG_STORAGE_KEY, lang);
      }
    } catch {
      // Language stays active in memory when browser storage is unavailable.
    }
  }

  /** In-flight flag for the profile save — double-submit protection + button state (A2). */
  readonly profileSaving = signal(false);

  // --- Profile save (F3) ---------------------------------------------------------
  saveProfile(): void {
    // A2 double protection: the button is disabled on invalid/pristine, and the handler blocks too.
    this.profileForm.markAllAsTouched();
    if (this.profileForm.invalid || this.profileForm.pristine || this.profileSaving()) return;
    const value = this.profileForm.getRawValue();
    this.profileSaving.set(true);
    this.operatorApi
      .updateProfile({
        displayName: value.displayName,
        phone: value.phone.trim(),
        jobTitle: value.jobTitle,
      })
      .pipe(
        finalize(() => this.profileSaving.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: profile => {
          this.profileForm.patchValue(
            {
              displayName: profile.displayName ?? '',
              email: profile.email,
              phone: profile.phone ?? '',
              jobTitle: profile.jobTitle ?? '',
            },
            { emitEvent: false },
          );
          // Saved state is the new baseline: the Save button disarms until the next edit.
          this.profileForm.markAsPristine();
          this.syncIdentity();
          this.toast.success(this.i18n.instant('settings.savedServer'));
        },
      });
  }

  /**
   * Discard unsaved profile edits (the ghost "Cancel" footer action): re-read the canonical profile
   * from the backend so the form + identity band snap back to the last persisted values. Reuses the
   * same `loadProfile()` path (patched with `emitEvent:false`, then `syncIdentity()`), so nothing is
   * written and the live band stays consistent.
   */
  cancelProfile(): void {
    this.loadProfile();
  }

  private loadProfile(): void {
    this.operatorApi
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: profile => {
          this.profileForm.patchValue(
            {
              displayName: profile.displayName ?? '',
              email: profile.email,
              phone: profile.phone ?? '',
              jobTitle: profile.jobTitle ?? '',
            },
            { emitEvent: false },
          );
          // The loaded server state is the clean baseline (also covers cancelProfile()).
          this.profileForm.markAsPristine();
          this.syncIdentity();
        },
      });
  }

  private loadNotificationPreferences(): void {
    this.operatorApi
      .getNotificationPreferences()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: prefs => this.notificationsForm.patchValue(prefs, { emitEvent: false }),
      });
  }

  private saveNotificationPreferences(): void {
    this.operatorApi
      .updateNotificationPreferences(this.notificationsForm.getRawValue())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: prefs => this.notificationsForm.patchValue(prefs, { emitEvent: false }),
      });
  }

  private loadAccessOverview(): void {
    this.accessLoading.set(true);
    this.accessLoadFailed.set(false);
    this.healthApi
      .getHealth()
      .pipe(
        catchError(() => {
          this.accessLoadFailed.set(true);
          return of(null as HealthStatus | null);
        }),
        finalize(() => this.accessLoading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(health => {
        this.health.set(health);
      });
  }

  // --- Security: MFA actions ---------------------------------------------------
  /**
   * Launch the enrolment wizard INSIDE the Settings drawer. The Settings shell stays
   * rendered behind the scrim; the wizard mounts fresh on the password step (seed null until the
   * password is submitted) and raises `done`/`cancelled` for {@link onMfaSetupDone}/{@link closeMfaSetup}.
   */
  enableMfa(): void {
    this.mfaSetupOpen.set(true);
  }

  /**
   * Enrolment finished (codes saved). Close the drawer — which destroys the wizard and clears its
   * transient secrets — and keep the operator on Settings › Security (no navigation away).
   */
  onMfaSetupDone(): void {
    this.mfaSetupOpen.set(false);
    this.mfaSetupDismissBlocked.set(false);
    this.landOnSecurity();
    // Status copy scoped strictly to the 2FA toggle (never KYC/identity-verification).
    this.toast.success(this.i18n.instant('mfa.setup.securitySavedStatus'));
  }

  /**
   * Clear the enrolment-drawer state on ANY abandonment path: close the drawer — which destroys the
   * wizard, whose `ngOnDestroy` GCs its transient QR/backup-code signals — release the dismiss block,
   * and say that enrolment was abandoned with the MFA-enabled state untouched. Deliberately does NOT
   * navigate: callers decide whether the operator should land on Security (a tab switch away from
   * Security must not yank them back).
   */
  private abandonMfaSetup(): void {
    this.mfaSetupOpen.set(false);
    this.mfaSetupDismissBlocked.set(false);
    // Status copy scoped strictly to the 2FA toggle: enrolment was abandoned, nothing changed.
    this.toast.info(this.i18n.instant('mfa.setup.securityCancelledStatus'));
  }

  /**
   * Close the enrolment drawer on ANY in-place dismissal path (Cancel button, Esc, scrim, the close
   * icon, or the wizard's own `cancelled` output). Single funnel so the drawer's `(closed)` output
   * routes through the SAME cancel semantics — {@link abandonMfaSetup} + stay on Settings › Security —
   * rather than a bare `[open]=false` toggle.
   */
  closeMfaSetup(): void {
    if (!this.mfaSetupOpen()) return;
    this.abandonMfaSetup();
    this.landOnSecurity();
  }

  /** Track the wizard's dismiss-block state so the drawer's `[disableClose]` stays in lock-step. */
  onMfaDismissBlockedChange(blocked: boolean): void {
    this.mfaSetupDismissBlocked.set(blocked);
  }

  /**
   * Ensure the operator is on Settings › Security after the drawer closes, and strip the one-shot
   * `/settings/mfa` deep-link from the URL so a refresh/Back doesn't re-open the wizard. Idempotent when
   * already on the security section with no mfa flag in the URL.
   */
  private landOnSecurity(): void {
    this.setActiveSection('security');
    void this.router.navigate(['/settings'], {
      queryParams: { section: 'security' },
      replaceUrl: true,
    });
  }

  /**
   * Administrator-only: open the operator MFA-reset screen (a dedicated lazy, permission-gated route).
   * The entry is wrapped in `*appHasPermission="'auth.mfa.admin_reset'"`, so operator/auditor never see
   * it; the route guard + the backend are the real authority.
   */
  openAdminMfaReset(): void {
    void this.router.navigate(['/settings/admin-mfa-reset']);
  }

  /**
   * Administrator-only: open the operator password-reset screen (a dedicated lazy, permission-gated
   * route). The entry is wrapped in `*appHasPermission="'auth.password.admin_reset'"`, so
   * operator/auditor never see it; the route guard + the backend are the real authority.
   */
  openAdminPasswordReset(): void {
    void this.router.navigate(['/admin-password-reset']);
  }

  /**
   * Open the full notifications history. The Notifications settings toggles map to the
   * real recipient-scoped feed; this links the preferences screen to that feed's page.
   */
  goToNotifications(): void {
    void this.router.navigate(['/notifications']);
  }

  /** Open the inline re-auth form for a disable or regenerate flow; resets any prior state. */
  openMfaAction(action: 'disable' | 'regenerate'): void {
    this.mfaAction.set(action);
    this.mfaErrorKey.set(null);
    this.mfaNewBackupCodes.set([]);
    this.mfaCodesSaved.set(false);
    this.mfaReauthForm.reset({ password: '', code: '' });
  }

  /** Toggle the "I have saved these" gate that unlocks dismissing the regenerated codes. */
  toggleMfaCodesSaved(): void {
    this.mfaCodesSaved.update(v => !v);
  }

  /** Cancel the inline re-auth form without submitting. */
  cancelMfaAction(): void {
    this.mfaAction.set(null);
    this.mfaErrorKey.set(null);
    this.mfaReauthForm.reset({ password: '', code: '' });
  }

  /** Submit the open disable/regenerate flow with the re-auth password + code. */
  submitMfaAction(): void {
    const action = this.mfaAction();
    if (!action || this.mfaSubmitting()) return;
    // A2 double protection: the submit button is disabled on invalid, and the handler blocks too.
    this.mfaReauthForm.markAllAsTouched();
    if (this.mfaReauthForm.invalid) return;
    const { password, code } = this.mfaReauthForm.getRawValue();
    this.mfaSubmitting.set(true);
    this.mfaErrorKey.set(null);

    if (action === 'disable') {
      this.auth
        .mfaDisable(password, code)
        .pipe(
          finalize(() => this.mfaSubmitting.set(false)),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe({
          next: () => {
            this.mfaAction.set(null);
            this.mfaReauthForm.reset({ password: '', code: '' });
            this.toast.success(this.i18n.instant('mfa.settings.disabledToast'));
          },
          error: () => this.mfaErrorKey.set('mfa.settings.actionError'),
        });
      return;
    }

    this.auth
      .mfaRegenerateBackupCodes(password, code)
      .pipe(
        finalize(() => this.mfaSubmitting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: result => {
          this.mfaNewBackupCodes.set(result.backupCodes);
          this.mfaCodesSaved.set(false);
          this.mfaReauthForm.reset({ password: '', code: '' });
        },
        error: () => this.mfaErrorKey.set('mfa.settings.actionError'),
      });
  }

  /**
   * Dismiss the one-time regenerated backup-code list (clears it from memory). Gated behind the
   * explicit "I have saved these" confirmation so the codes can't be lost with a stray click.
   */
  dismissNewBackupCodes(): void {
    if (!this.mfaCodesSaved()) return;
    this.mfaNewBackupCodes.set([]);
    this.mfaCodesSaved.set(false);
    this.mfaAction.set(null);
  }

  // --- Security: Trusted-device actions ----------------------------------------
  /**
   * Load the operator's active trusted devices; renders the error+retry block on failure (the list
   * stays empty).
   */
  loadDevices(): void {
    this.devicesLoading.set(true);
    this.devicesErrorKey.set(null);
    this.auth
      .mfaListDevices()
      .pipe(
        finalize(() => this.devicesLoading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: devices => this.devices.set(devices),
        error: () => this.devicesErrorKey.set('mfa.devices.errorBody'),
      });
  }

  /** Retry a failed device load. */
  retryLoadDevices(): void {
    this.loadDevices();
  }

  /** Open the confirm dialog for revoking a specific device. */
  askRevoke(id: string): void {
    this.confirmRevokeId.set(id);
  }

  /** Close the confirm dialog without revoking (no state change to the list). */
  cancelRevoke(): void {
    if (this.revokingId()) return;
    this.confirmRevokeId.set(null);
  }

  /**
   * Confirm the pending revoke. OPTIMISTIC: the row is removed immediately, then the DELETE is sent. On
   * failure the removed device is RESTORED in its original position (rollback) and an error toast shown —
   * EXCEPT a 404, which means the device was already gone, so the optimistic removal stands (idempotent).
   */
  confirmRevoke(): void {
    const id = this.confirmRevokeId();
    if (!id || this.revokingId()) return;

    const previous = this.devices();
    const index = previous.findIndex(d => d.id === id);
    if (index === -1) {
      this.confirmRevokeId.set(null);
      return;
    }

    // Optimistic removal — drop the row before the network call resolves.
    this.devices.set(previous.filter(d => d.id !== id));
    this.revokingId.set(id);

    this.auth
      .mfaRevokeDevice(id)
      .pipe(
        finalize(() => {
          this.revokingId.set(null);
          this.confirmRevokeId.set(null);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.toast.success(this.i18n.instant('mfa.devices.revokedToast')),
        error: (err: unknown) => {
          // 404 = already revoked elsewhere: the optimistic removal is correct, so keep it (idempotent).
          if (err instanceof HttpErrorResponse && err.status === 404) {
            this.toast.success(this.i18n.instant('mfa.devices.revokedToast'));
            return;
          }
          // Any other failure: restore the device to its original slot and surface the error.
          this.devices.set(this.insertAt(this.devices(), previous[index], index));
          this.toast.error(this.i18n.instant('mfa.devices.revokeError'));
        },
      });
  }

  /** Re-insert a rolled-back device at its original index (clamped), preserving list order. */
  private insertAt(
    list: readonly RememberedDevice[],
    device: RememberedDevice,
    index: number,
  ): readonly RememberedDevice[] {
    const next = [...list];
    next.splice(Math.min(index, next.length), 0, device);
    return next;
  }

  private isSettingsSection(value: string | null): value is SettingsSection {
    return (
      value === 'profile' ||
      value === 'security' ||
      value === 'appearance' ||
      value === 'language' ||
      value === 'notifications' ||
      value === 'access'
    );
  }

  /** Access is self-scoped and viewable by every authenticated operator. */
  private canViewSection(section: SettingsSection): boolean {
    return !!section;
  }
}
