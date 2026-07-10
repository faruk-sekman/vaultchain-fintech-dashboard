/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ElementRef, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HeaderComponent } from './header/header.component';
import { MainLayoutComponent } from './main-layout/main-layout.component';
import { SidebarComponent } from './sidebar/sidebar.component';
import { ThemeService } from '@core/services/theme.service';
import { LoadingService } from '@core/services/loading.service';
import { AuthService } from '@core/auth/auth.service';
import { OperatorApi } from '@core/api/operator.api';
import { NotificationStore } from '@core/state/notification.store';
import { PageTitleService } from './page-title.service';
import { TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';

class TranslateMock {
  currentLang = 'en';
  use = vi.fn((lang: string) => {
    this.currentLang = lang;
  });
}

const authStub = {
  isAuthenticated: () => false,
  principal: () => null,
  loadPrincipal: () => of(null),
};

describe('Layout components', () => {
  let routerStub: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    routerStub = { navigate: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ThemeService,
          useValue: {
            theme: signal<'light' | 'dark'>('light'),
            setTheme: vi.fn(),
            toggleTheme: vi.fn(),
          },
        },
        { provide: LoadingService, useValue: { loading$: of(false) } },
        { provide: TranslateService, useClass: TranslateMock },
        { provide: AuthService, useValue: authStub },
        {
          provide: OperatorApi,
          useValue: { listNotifications: vi.fn(() => of({ items: [], unreadCount: 0 })) },
        },
        { provide: Router, useValue: routerStub },
        {
          provide: PageTitleService,
          useValue: { titleKey: () => 'app.title', override: () => null, setOverride: vi.fn() },
        },
        { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
        {
          provide: NotificationStore,
          useValue: {
            recent: signal([]),
            unreadCount: signal(0),
            hasUnread: signal(false),
            loaded: signal(false),
            init: vi.fn(),
            refresh: vi.fn(),
          },
        },
      ],
    });
  });

  const makeLayout = () => TestBed.runInInjectionContext(() => new MainLayoutComponent());

  it('HeaderComponent switches language and theme', () => {
    const translate = TestBed.inject(TranslateService) as any as TranslateMock;
    const component = TestBed.runInInjectionContext(
      () => new HeaderComponent(translate as any, TestBed.inject(LoadingService)),
    );

    component.switchLang('tr');
    expect(translate.use).toHaveBeenCalledWith('tr');
    expect(component.currentLang()).toBe('tr');

    const themeService = TestBed.inject(ThemeService) as any;
    component.setTheme('dark');
    expect(themeService.setTheme).toHaveBeenCalledWith('dark');
  });

  it('MainLayoutComponent and SidebarComponent instantiate', () => {
    expect(makeLayout()).toBeTruthy();
    // Both components use inject() in field initializers, so construct them within an
    // injection context (SidebarService is providedIn: 'root', so TestBed resolves it).
    expect(TestBed.runInInjectionContext(() => new SidebarComponent())).toBeTruthy();
  });

  it('MainLayoutComponent toggles mobile nav state', () => {
    const component = makeLayout();

    component.toggleMobileNav();
    expect(component.mobileNavOpen).toBe(true);

    component.closeMobileNav();
    expect(component.mobileNavOpen).toBe(false);
  });

  it('routes global search to the customers list search query', () => {
    const component = makeLayout();

    component.onGlobalSearch('  ada lovelace  ');

    expect(routerStub.navigate).toHaveBeenCalledWith(['/customers'], {
      queryParams: { search: 'ada lovelace', page: null },
      queryParamsHandling: 'merge',
    });
  });

  it('MainLayoutComponent prepares and updates route animation keys', async () => {
    const component = makeLayout();
    const inactiveOutlet = { isActivated: false } as any;
    const customerOutlet = {
      isActivated: true,
      activatedRoute: { snapshot: { routeConfig: { path: 'customers' } } },
    } as any;
    const homeOutlet = {
      isActivated: true,
      activatedRoute: { snapshot: { routeConfig: {} } },
    } as any;

    component.routeKey.set('existing');
    expect(component.prepareRoute(inactiveOutlet)).toBe('existing');
    expect(component.prepareRoute(customerOutlet)).toBe('customers');
    expect(component.prepareRoute(homeOutlet)).toBe('home');

    component.updateRoute(customerOutlet);
    await Promise.resolve();
    expect(component.routeKey()).toBe('customers');
  });
});
