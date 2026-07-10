/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Direct (no-DOM) tests. The sidebar template is RouterLink + permission-directive driven; these
 * pin the A18 grouped-nav model (groups, gates, unread badge), the pinned user card's identity
 * (own FULL email, B9) and menu actions, plus the A1 inputs/outputs and collapse-service wiring.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { OperatorApi } from '@core/api/operator.api';
import { SidebarService } from '@core/services/sidebar.service';
import { NotificationStore } from '@core/state/notification.store';
import { SidebarComponent } from './sidebar.component';

interface MakeOptions {
  principal?: unknown;
  unread?: number;
  collapsed?: boolean;
  profile?: 'ok' | 'error';
}

function make(opts: MakeOptions = {}) {
  TestBed.resetTestingModule();
  const unread = signal(opts.unread ?? 0);
  const auth = {
    principal: () => opts.principal ?? null,
    logout: vi.fn(() => of(undefined)),
  };
  const operatorApi = {
    getProfile: vi.fn(() =>
      opts.profile === 'error'
        ? throwError(() => new Error('nope'))
        : of({ displayName: 'Local Operator', email: 'operator@example.com' }),
    ),
  };
  const router = { navigate: vi.fn() };
  const sidebarService = { collapsed: () => opts.collapsed ?? false, toggle: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: SidebarService, useValue: sidebarService },
      { provide: NotificationStore, useValue: { unreadCount: unread } },
      { provide: AuthService, useValue: auth },
      { provide: OperatorApi, useValue: operatorApi },
      { provide: Router, useValue: router },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new SidebarComponent());
  return { component, unread, auth, operatorApi, router };
}

describe('SidebarComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the brand row by default (rail instance)', () => {
    expect(make().component.showBrand).toBe(true);
  });

  it('emits navigate so the mobile drawer can close on link activation', () => {
    const { component } = make();
    let count = 0;
    component.navigate.subscribe(() => count++);
    component.navigate.emit();
    expect(count).toBe(1);
  });

  it('exposes the injected collapse service', () => {
    expect(make().component.sidebar).toBeDefined();
  });

  // --- A18: grouped navigation ---

  it('renders the nav as three labelled groups in spec order (main / insights / other)', () => {
    const { component } = make();
    expect(component.navGroups.map(g => g.id)).toEqual(['main', 'insights', 'other']);
    expect(component.navGroups.map(g => g.labelKey)).toEqual([
      'nav.sections.main',
      'nav.sections.insights',
      'nav.sections.other',
    ]);
    expect(component.navGroups.map(g => g.items.map(i => i.id))).toEqual([
      ['dashboard', 'customers', 'notifications'],
      ['analytics'],
      // EK-2: the reset-requests entry is gone — the queue is a section OF the password-reset page.
      ['settings', 'passwordReset'],
    ]);
  });

  it('keeps every permission gate exactly (and no new ones; EK-2 removed only the resetRequests row)', () => {
    const { component } = make();
    const items = component.navGroups.flatMap(g => g.items);
    const gates = Object.fromEntries(items.map(i => [i.id, i.permission]));
    expect(gates).toEqual({
      dashboard: undefined,
      customers: 'customers.read',
      notifications: undefined,
      analytics: undefined,
      settings: undefined,
      passwordReset: 'auth.password.admin_reset',
    });
  });

  it('keeps the routes (single admin recovery entry, EK-2) and marks only Bildirimler as counted', () => {
    const { component } = make();
    const items = component.navGroups.flatMap(g => g.items);
    expect(items.map(i => i.route)).toEqual([
      '/dashboard',
      '/customers',
      '/notifications',
      '/analytics',
      '/settings',
      '/admin-password-reset',
    ]);
    expect(items.filter(i => i.counter).map(i => i.id)).toEqual(['notifications']);
  });

  // --- A18: unread-count pill ---

  it('reflects the shared store count and formats 99+ past two digits', () => {
    const { component, unread } = make({ unread: 3 });
    expect(component.unreadCount()).toBe(3);
    expect(component.unreadBadge()).toBe('3');
    unread.set(120);
    expect(component.unreadBadge()).toBe('99+');
  });

  // --- A18: pinned user card ---

  it('derives an empty user (and fetches nothing) when no principal is loaded', () => {
    const { component, operatorApi } = make({ principal: null });
    expect(component.currentUser).toEqual({ name: '', email: '' });
    expect(operatorApi.getProfile).not.toHaveBeenCalled();
  });

  it('shows the OWN email IN FULL from the one-shot profile fetch (B9)', () => {
    const { component, operatorApi } = make({
      principal: { user: { displayName: 'Local Operator', email: 'o***@masked' } },
    });
    expect(component.currentUser).toEqual({
      name: 'Local Operator',
      email: 'operator@example.com',
    });
    // Idempotent: a second read never re-fires the request.
    expect(component.currentUser.email).toBe('operator@example.com');
    expect(operatorApi.getProfile).toHaveBeenCalledTimes(1);
  });

  it('falls back to the masked principal email when the profile fetch fails', () => {
    const { component } = make({
      principal: { user: { displayName: 'Ada', email: 'a***@masked' } },
      profile: 'error',
    });
    expect(component.currentUser).toEqual({ name: 'Ada', email: 'a***@masked' });
  });

  it('suppresses the email line when it would just repeat the name (no displayName)', () => {
    const { component } = make({
      principal: { user: { displayName: null, email: 'o***@masked' } },
    });
    expect(component.currentUser).toEqual({ name: 'operator@example.com', email: '' });
  });

  // --- A18: collapsed-rail rendering state ---

  it('railCollapsed follows the service for the rail instance only (drawer stays expanded)', () => {
    const rail = make({ collapsed: true }).component;
    expect(rail.railCollapsed()).toBe(true);

    const drawer = make({ collapsed: true }).component;
    drawer.showBrand = false;
    expect(drawer.railCollapsed()).toBe(false);

    const open = make({ collapsed: false }).component;
    expect(open.railCollapsed()).toBe(false);
  });

  // --- A18: user-card account menu (same actions as the header menu) ---

  it('offers the header account-menu anatomy: profile, settings, divider, danger logout', () => {
    const { component } = make();
    expect(component.userMenuEntries.map(e => e.id)).toEqual([
      'profile',
      'settings',
      'sep-logout',
      'logout',
    ]);
    expect(component.userMenuEntries[2]).toMatchObject({ kind: 'divider' });
    expect(component.userMenuEntries[3]).toMatchObject({ danger: true });
  });

  it('routes Profile and Settings and emits navigate so the drawer can close', () => {
    const { component, router } = make();
    let closed = 0;
    component.navigate.subscribe(() => closed++);

    component.onUserMenuSelect('profile');
    expect(router.navigate).toHaveBeenCalledWith(['/settings'], {
      queryParams: { section: 'profile' },
    });
    component.onUserMenuSelect('settings');
    expect(router.navigate).toHaveBeenCalledWith(['/settings']);
    expect(closed).toBe(2);
  });

  it('signs out via AuthService and lands on /login (no drawer-close emit)', () => {
    const { component, auth, router } = make();
    let closed = 0;
    component.navigate.subscribe(() => closed++);

    component.onUserMenuSelect('logout');
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
    expect(closed).toBe(0);
  });

  it('ignores a second logout while the first is in flight (idempotent)', () => {
    const { component, auth, router } = make();
    auth.logout.mockReturnValueOnce(NEVER as never);
    component.onUserMenuSelect('logout');
    component.onUserMenuSelect('logout');
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
