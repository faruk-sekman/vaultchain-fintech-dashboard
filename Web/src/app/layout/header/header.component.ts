/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  HostListener,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Observable } from 'rxjs';
import {
  AppNotification,
  NOTIFICATION_FALLBACK_BODY_KEY,
  NOTIFICATION_FALLBACK_TITLE_KEY,
  NotificationSeverity,
  notificationText,
  notificationTypeIcon,
  notificationTypeKey,
} from '@core/api/notification.api';
import { NotificationStore } from '@core/state/notification.store';
import { AuthService } from '@core/auth/auth.service';
import { LoadingService } from '@core/services/loading.service';
import { OperatorApi } from '@core/api/operator.api';
import { ThemeService } from '@core/services/theme.service';
import { UiAvatarComponent } from '@shared/components/ui-avatar/ui-avatar.component';
import type { UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';
import { UiMenuComponent, UiMenuEntry } from '@shared/components/ui-menu/ui-menu.component';
import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { IconPopDirective } from '@shared/directives/icon-pop.directive';
import { UiTooltipDirective } from '@shared/components/ui-tooltip/ui-tooltip.directive';
import { relativeTime } from '@shared/utils/relative-time.util';
import { PageTitleService } from '../page-title.service';

/** Identifiers for the user-menu rows (kept stable; emitted by `app-ui-menu`). */
type UserMenuAction = 'profile' | 'settings' | 'logout';

/**
 * Severity → badge colour family (mirrors `notifications.component.ts`, so the bell dropdown reads
 * as the same family as the `/notifications` page it deep-links to). The badge ALSO carries text +
 * the row carries a tile/glyph, so colour is never the only severity signal.
 */
const SEVERITY_BADGE: Readonly<Record<NotificationSeverity, UiBadgeColor>> = {
  info: 'blue',
  success: 'green',
  warning: 'yellow',
  critical: 'red',
};

/** STATIC severity → i18n key map (no dynamic key building, so `i18n:check` sees every key). */
const SEVERITY_KEY: Readonly<Record<NotificationSeverity, string>> = {
  info: 'notifications.severity.info',
  success: 'notifications.severity.success',
  warning: 'notifications.severity.warning',
  critical: 'notifications.severity.critical',
};

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiMenuComponent,
    UiAvatarComponent,
    UiEmptyComponent,
    UiSegmentedComponent,
    UiSkeletonComponent,
    IconPopDirective,
    UiTooltipDirective,
  ],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeaderComponent implements OnInit {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  @Output() menuToggle = new EventEmitter<void>();
  /**
   * Emits the trimmed query when the operator submits the global search.
   * No global search backend exists yet (verified absent), so the host is
   * expected to wire this; the header itself does not fabricate results.
   */
  @Output() search = new EventEmitter<string>();

  loading$: Observable<boolean>;
  private readonly themeService = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationStore);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly theme = this.themeService.theme;
  /** Header-owned page title source (v2 §3.2): route `data.titleKey` + dynamic override. */
  readonly pageTitle = inject(PageTitleService);

  /** Bound to the global-search field; local view state only (no store duplication). */
  readonly searchControl = new FormControl<string>('', { nonNullable: true });

  /**
   * User dropdown rows (v2 §3.2): profile/settings, the EN/TR language switch (moved here
   * from the old segmented control), and Logout. Rebuilt per change detection so the active
   * language row carries the check icon; ngx-translate's pipe marks the header for check on
   * language change, which re-reads this getter.
   */
  /** Language now lives in the header toolbar (the EN/TR segmented), not in this menu. */
  readonly langOptions: ReadonlyArray<UiSegmentItem> = [
    { value: 'en', label: 'EN' },
    { value: 'tr', label: 'TR' },
  ];

  get userMenuEntries(): UiMenuEntry[] {
    return [
      { id: 'profile', labelKey: 'nav.profile', icon: 'ri-user-3-line' },
      { id: 'settings', labelKey: 'nav.settings', icon: 'ri-settings-3-line' },
      { kind: 'divider', id: 'sep-logout' },
      { id: 'logout', labelKey: 'common.logout', icon: 'ri-logout-box-r-line', danger: true },
    ];
  }

  /** EN/TR switch from the header segmented. */
  onLangChange(value: string): void {
    this.switchLang(value === 'tr' ? 'tr' : 'en');
  }

  /** Live notification state (badge + dropdown rows), shared with the `/notifications` page. */
  readonly recentNotifications = this.notifications.recent;
  readonly unreadCount = this.notifications.unreadCount;
  readonly hasUnread = this.notifications.hasUnread;
  readonly notificationsLoaded = this.notifications.loaded;

  /** Whether the bespoke notifications popover is open (local view state). */
  readonly notificationsOpen = signal(false);

  /** Static type → i18n label key (replaces the old dynamic `notificationLabelKey` switch). */
  notificationLabel(type: string): string {
    return notificationTypeKey(type);
  }

  /** Static type → remix-icon (colour-independent affordance). */
  notificationIcon(type: string): string {
    return notificationTypeIcon(type);
  }

  /** Relative-time i18n key + params for a notification's `createdAt` (e.g. "5 min ago"). */
  notificationTime(createdAt: string): {
    key: string;
    params: Record<string, number>;
    absolute: boolean;
  } {
    return relativeTime(createdAt);
  }

  /** The BE titleKey resolved to text, with a safe fallback if the FE bundle lacks that key. */
  notificationTitle(item: AppNotification): string {
    return notificationText(this.i18n, item.titleKey, item.params, NOTIFICATION_FALLBACK_TITLE_KEY);
  }

  /** The BE bodyKey resolved to a one-line snippet, with a safe fallback if the FE bundle lacks it. */
  notificationBody(item: AppNotification): string {
    return notificationText(this.i18n, item.bodyKey, item.params, NOTIFICATION_FALLBACK_BODY_KEY);
  }

  /** Severity → badge colour family (mirrors the `/notifications` page; colour is never the only cue). */
  severityColor(severity: NotificationSeverity): UiBadgeColor {
    return SEVERITY_BADGE[severity] ?? 'gray';
  }

  /** Severity → static badge-label i18n key (defaults to the generic `info` key for an unknown value). */
  severityKey(severity: NotificationSeverity): string {
    return SEVERITY_KEY[severity] ?? 'notifications.severity.info';
  }

  /** Guards against a double-click firing two logout flows. */
  private loggingOut = false;

  /**
   * B9 (bugfix-backlog-2026-07): the operator's OWN full email, lazily fetched once from the
   * profile endpoint. Standard applied: your own identity renders UNMASKED on every surface
   * (matching Settings) — it is the caller's own data, not third-party PII, and account
   * confirmation is the point of the identity line. The audited /auth/me contract stays masked;
   * until (or if) the profile fetch resolves, the masked principal email is the fallback.
   */
  private readonly ownEmail = signal<string | null>(null);
  private ownEmailRequested = false;

  /** The authenticated operator identity (real principal from login / GET /auth/me). */
  get currentUser(): { name: string; role: string } {
    const user = this.auth.principal()?.user;
    if (!user) return { name: '', role: '' };
    this.ensureOwnEmail();
    const email = this.ownEmail() ?? user.email;
    const name = user.displayName ?? email;
    // Secondary line: the (own, full — B9) email; shown only when the primary isn't already it.
    const role = user.displayName ? email : '';
    return { name, role };
  }

  /** Fire the one-shot own-profile fetch (idempotent; a failure silently keeps the masked fallback). */
  private ensureOwnEmail(): void {
    if (this.ownEmailRequested) return;
    this.ownEmailRequested = true;
    this.operatorApi
      .getProfile()
      .pipe(takeUntilDestroyed(this.headerDestroyRef))
      .subscribe({
        next: profile => this.ownEmail.set(profile.email),
        error: () => undefined,
      });
  }

  private readonly operatorApi = inject(OperatorApi);
  private readonly headerDestroyRef = inject(DestroyRef);

  constructor(
    private readonly i18n: TranslateService,
    private readonly loading: LoadingService,
  ) {
    this.loading$ = this.loading.loading$;
  }

  ngOnInit(): void {
    // Start the shared live feed (loads the head + subscribes to the recipient-scoped SSE event). The
    // store is `providedIn: 'root'` and idempotent, so the `/notifications` page shares this one feed.
    this.notifications.init();
  }

  /** Toggle the bespoke notifications popover; opening refreshes the feed so the badge is current. */
  toggleNotifications(): void {
    const next = !this.notificationsOpen();
    this.notificationsOpen.set(next);
    if (next) {
      this.notifications.refresh();
      // Move focus into the role="dialog" popover once it renders so keyboard / screen-reader users land
      // inside it instead of being left on the trigger (re-audit A11Y-002).
      setTimeout(() =>
        this.host.nativeElement.querySelector<HTMLElement>('#header-notifications-panel')?.focus(),
      );
    }
  }

  /** Close the popover (Esc, outside click, or after an item action). */
  closeNotifications(): void {
    if (this.notificationsOpen()) this.notificationsOpen.set(false);
  }

  /** Close the popover when a click lands outside the header's notifications cluster. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.notificationsOpen()) return;
    const cluster = this.host.nativeElement.querySelector('.notifications');
    if (cluster && !cluster.contains(event.target as Node)) {
      this.notificationsOpen.set(false);
    }
  }

  /** Dismiss the popover on Escape and restore focus to the trigger (re-audit A11Y-002). Focus is NOT
   * restored on outside pointer-click — there the browser already moved focus to the clicked element. */
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (!this.notificationsOpen()) return;
    this.closeNotifications();
    this.host.nativeElement.querySelector<HTMLButtonElement>('.notifications__trigger')?.focus();
  }

  /**
   * Activate a dropdown row: mark it read (if unread) and, when it carries a resource, navigate to it.
   * Closes the popover. Recognised resource types route to their detail screen; an unknown/absent
   * resource just marks-read in place (no dead navigation).
   */
  onNotificationClick(item: AppNotification): void {
    if (!item.readAt) this.notifications.markRead(item.id);
    this.closeNotifications();
    const target = this.notificationRoute(item);
    if (target) void this.router.navigate(target.commands, target.extras);
  }

  /** Mark every unread notification read (badge → 0) without leaving the current screen. */
  markAllNotificationsRead(): void {
    this.notifications.markAll();
  }

  /** "See all" → the full paged notifications page; closes the popover. */
  goToAllNotifications(): void {
    this.closeNotifications();
    void this.router.navigate(['/notifications']);
  }

  /**
   * Map a notification's `resourceType`/`resourceId` to a deep link (router commands + optional
   * extras), or null when it has no navigable subject. Only known resource types route (no
   * fabricated links); customer-scoped events open the customer detail.
   */
  private notificationRoute(
    item: AppNotification,
  ): { commands: unknown[]; extras?: { queryParams: Record<string, string> } } | null {
    if (!item.resourceId) return null;
    if (item.resourceType === 'customer') return { commands: ['/customers', item.resourceId] };
    // EK-2: the reset-request SECURITY_ALERT deep-links to the merged admin recovery page, where
    // `?request=` preselects (and scrolls to) that request in the embedded review section.
    if (item.resourceType === 'password_reset_request')
      return {
        commands: ['/admin-password-reset'],
        extras: { queryParams: { request: item.resourceId } },
      };
    return null;
  }

  switchLang(lang: 'en' | 'tr') {
    this.i18n.use(lang);
    this.persistLang(lang);
    this.applyDocumentLang(lang);
  }

  /**
   * Reflects the active language on `<html lang>` (WCAG 3.1.1) so assistive tech reads the page
   * in the right language. Mirrors `ThemeService`'s `documentElement` pattern; guarded for
   * headless/SSR contexts. Note: Angular's `LOCALE_ID` is bootstrap-fixed, so pipe/`formatDate`
   * output reformats on the next reload — this only updates the lang attribute live.
   */
  private applyDocumentLang(lang: 'en' | 'tr'): void {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
  }

  currentLang(): 'en' | 'tr' {
    if (this.i18n.currentLang === 'tr') return 'tr';
    return 'en';
  }

  setTheme(mode: 'light' | 'dark') {
    this.themeService.setTheme(mode);
  }

  /** Flip light↔dark from the compact toolbar toggle. */
  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  /** Emit the trimmed query; blank submissions are ignored. */
  onSearch(): void {
    const query = this.searchControl.value.trim();
    if (!query) return;
    this.search.emit(query);
  }

  /** Route the user-menu selection; Logout delegates to the unchanged `onLogout()`. */
  onUserMenuSelect(id: string): void {
    switch (id as UserMenuAction) {
      case 'profile':
        void this.router.navigate(['/settings'], { queryParams: { section: 'profile' } });
        break;
      case 'settings':
        void this.router.navigate(['/settings']);
        break;
      case 'logout':
        this.onLogout();
        break;
    }
  }

  /**
   * Sign the operator out: clear the session (and revoke the refresh token server-side via
   * `AuthService.logout()`), then land on `/login`. The local session is cleared synchronously, so
   * a `/auth/logout` network failure still navigates and never strands the operator signed-in.
   * Idempotent — a second click while the first is in flight is ignored.
   */
  onLogout() {
    if (this.loggingOut) return;
    this.loggingOut = true;

    // `AuthService.logout()` clears the session synchronously and swallows revoke failures, so this
    // stream always completes — navigate to /login on completion.
    this.auth
      .logout()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => {
          this.loggingOut = false;
          void this.router.navigate(['/login']);
        },
      });
  }

  private persistLang(lang: 'en' | 'tr') {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('lang', lang);
      }
    } catch {
      // Language remains active in memory when browser storage is unavailable.
    }
  }
}
