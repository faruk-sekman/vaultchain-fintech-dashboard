/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '@core/auth/auth.service';
import { OperatorApi } from '@core/api/operator.api';
import { SidebarService } from '@core/services/sidebar.service';
import { NotificationStore } from '@core/state/notification.store';
import { UiAvatarComponent } from '@shared/components/ui-avatar/ui-avatar.component';
import { UiLogoComponent } from '@shared/components/ui-logo/ui-logo.component';
import { UiMenuComponent, UiMenuEntry } from '@shared/components/ui-menu/ui-menu.component';
import { UiTooltipDirective } from '@shared/components/ui-tooltip/ui-tooltip.directive';
import { HasPermissionDirective } from '@shared/directives/has-permission.directive';

/** One nav row (A18): route + label + icons, optionally permission-gated / unread-counted. */
export interface SidebarNavItem {
  id: string;
  route: string;
  labelKey: string;
  icon: string;
  /** Filled icon swapped in while the route is active (omitted = static glyph). */
  iconActive?: string;
  /** FE permission gate (defense-in-depth; the BE guard stays authoritative). */
  permission?: string;
  /** Marks the row that carries the live unread-count pill (Bildirimler). */
  counter?: boolean;
}

/** A titled nav group rendered with an uppercase micro-label header (A18 spec §1). */
export interface SidebarNavGroup {
  id: string;
  labelKey: string;
  items: readonly SidebarNavItem[];
}

/** Identifiers for the pinned-user-card menu rows (same set as the header account menu). */
type UserMenuAction = 'profile' | 'settings' | 'logout';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    TranslateModule,
    UiAvatarComponent,
    UiLogoComponent,
    UiMenuComponent,
    UiTooltipDirective,
    HasPermissionDirective,
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  /** Hide the brand row where the host already provides a heading (mobile drawer). */
  @Input() showBrand = true;
  @Output() navigate = new EventEmitter<void>();

  /**
   * Desktop rail collapse state (icon-only + hover flyout labels). Only the rail instance
   * (showBrand=true) reflects it; the mobile drawer instance stays fully expanded.
   */
  readonly sidebar = inject(SidebarService);

  private readonly notifications = inject(NotificationStore);
  private readonly auth = inject(AuthService);
  private readonly operatorApi = inject(OperatorApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * A18 grouped navigation — the CURRENT entries under uppercase micro-label sections
   * (spec: MENU / ANALYTICS / OTHER). Permission gates are IDENTICAL to the pre-A18 flat list.
   */
  readonly navGroups: readonly SidebarNavGroup[] = [
    {
      id: 'main',
      labelKey: 'nav.sections.main',
      items: [
        {
          id: 'dashboard',
          route: '/dashboard',
          labelKey: 'nav.dashboard',
          icon: 'ri-dashboard-line',
          iconActive: 'ri-dashboard-fill',
        },
        {
          id: 'customers',
          route: '/customers',
          labelKey: 'nav.customers',
          icon: 'ri-group-line',
          iconActive: 'ri-group-fill',
          permission: 'customers.read',
        },
        {
          id: 'notifications',
          route: '/notifications',
          labelKey: 'nav.notifications',
          icon: 'ri-notification-3-line',
          counter: true,
        },
      ],
    },
    {
      id: 'insights',
      labelKey: 'nav.sections.insights',
      items: [
        {
          id: 'analytics',
          route: '/analytics',
          labelKey: 'nav.analytics',
          icon: 'ri-line-chart-line',
          iconActive: 'ri-line-chart-fill',
        },
      ],
    },
    {
      id: 'other',
      labelKey: 'nav.sections.other',
      items: [
        {
          id: 'settings',
          route: '/settings',
          labelKey: 'nav.settings',
          icon: 'ri-settings-3-line',
          iconActive: 'ri-settings-3-fill',
        },
        {
          // EK-2: the single admin recovery entry — the reset-requests queue is a section OF this
          // page now (its standalone route + separate sidebar entry were removed).
          id: 'passwordReset',
          route: '/admin-password-reset',
          labelKey: 'nav.passwordReset',
          icon: 'ri-lock-2-line',
          permission: 'auth.password.admin_reset',
        },
      ],
    },
  ];

  /** Live unread total from the shared store the header already feeds (read-only here). */
  readonly unreadCount = this.notifications.unreadCount;
  /** Pill text: exact count up to 99, then "99+" (A18 spec §1). */
  readonly unreadBadge = computed(() => {
    const count = this.unreadCount();
    return count > 99 ? '99+' : String(count);
  });

  /** Pinned-card menu rows — the same account actions as the header profile menu. */
  readonly userMenuEntries: UiMenuEntry[] = [
    { id: 'profile', labelKey: 'nav.profile', icon: 'ri-user-3-line' },
    { id: 'settings', labelKey: 'nav.settings', icon: 'ri-settings-3-line' },
    { kind: 'divider', id: 'sep-logout' },
    { id: 'logout', labelKey: 'common.logout', icon: 'ri-logout-box-r-line', danger: true },
  ];

  /**
   * B9 standard (mirrors the header): the operator's OWN email renders IN FULL, lazily
   * fetched once from the profile endpoint; the masked principal email is the fallback
   * until (or if) that fetch resolves. Own identity is not third-party PII.
   */
  private readonly ownEmail = signal<string | null>(null);
  private ownEmailRequested = false;

  /** Guards against a double-click firing two logout flows. */
  private loggingOut = false;

  /** The authenticated operator for the pinned card (email blank when it would repeat the name). */
  get currentUser(): { name: string; email: string } {
    const user = this.auth.principal()?.user;
    if (!user) return { name: '', email: '' };
    this.ensureOwnEmail();
    const email = this.ownEmail() ?? user.email;
    return { name: user.displayName ?? email, email: user.displayName ? email : '' };
  }

  /** True only for the desktop rail instance while it is collapsed to the 84px icon rail. */
  railCollapsed(): boolean {
    return this.showBrand && this.sidebar.collapsed();
  }

  /** Route the pinned-card menu selection (same actions as the header account menu). */
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
        return; // logout leaves the shell; no drawer-close emit needed
    }
    this.navigate.emit(); // lets the mobile drawer close after navigating
  }

  /** Fire the one-shot own-profile fetch (idempotent; a failure keeps the masked fallback). */
  private ensureOwnEmail(): void {
    if (this.ownEmailRequested) return;
    this.ownEmailRequested = true;
    this.operatorApi
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: profile => this.ownEmail.set(profile.email),
        error: () => undefined,
      });
  }

  /** Sign out via the shared AuthService flow, then land on /login (idempotent). */
  private onLogout(): void {
    if (this.loggingOut) return;
    this.loggingOut = true;
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
}
