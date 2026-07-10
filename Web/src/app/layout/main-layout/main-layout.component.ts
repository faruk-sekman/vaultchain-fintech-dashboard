/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { EMPTY, catchError } from 'rxjs';
import { AuthService } from '@core/auth/auth.service';
import { SidebarService } from '@core/services/sidebar.service';
import { HeaderComponent } from '../header/header.component';
import { SidebarComponent } from '../sidebar/sidebar.component';
import { routeFade } from '@shared/animations/route-animations';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, TranslateModule, HeaderComponent, SidebarComponent],
  templateUrl: './main-layout.component.html',
  styleUrl: './main-layout.component.scss',
  animations: [routeFade],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MainLayoutComponent implements OnInit {
  mobileNavOpen = false;
  readonly routeKey = signal('home');
  /**
   * §12: @angular/animations writes inline styles, so the global CSS
   * reduced-motion block cannot collapse the route transition — disable
   * the trigger itself (instant swap). Guarded for headless test runs.
   */
  readonly reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  /** Desktop rail collapse state — drives the shell grid column width. */
  readonly sidebar = inject(SidebarService);

  ngOnInit(): void {
    // After a hard reload only the access token is persisted; rehydrate the real operator identity
    // + permissions from GET /auth/me so the header (and any permission-gated UI) is never stale.
    if (this.auth.isAuthenticated() && !this.auth.principal()) {
      this.auth
        .loadPrincipal()
        .pipe(catchError(() => EMPTY))
        .subscribe();
    }
  }

  toggleMobileNav() {
    this.mobileNavOpen = !this.mobileNavOpen;
  }

  closeMobileNav() {
    this.mobileNavOpen = false;
  }

  onGlobalSearch(query: string): void {
    const search = query.trim();
    if (!search) return;

    void this.router.navigate(['/customers'], {
      queryParams: { search, page: null },
      queryParamsHandling: 'merge',
    });
  }

  updateRoute(outlet: RouterOutlet): void {
    queueMicrotask(() => {
      this.routeKey.set(this.prepareRoute(outlet));
    });
  }

  /** Distinct key per page so the route transition fires on real navigations. */
  prepareRoute(outlet: RouterOutlet): string {
    if (!outlet || !outlet.isActivated) {
      return this.routeKey();
    }
    return outlet.activatedRoute.snapshot.routeConfig?.path || 'home';
  }
}
