/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Administrator review SECTION for password-reset REQUESTS (A15/A16, merged per EK-2) — the approval
 * queue behind the forgot-password wizard's "request an administrator reset" fallback. No longer a
 * standalone page: it renders as the BOTTOM section of `admin-password-reset.component` (the single
 * admin recovery page; the old `/admin-reset-requests(/:id)` URLs redirect there). Access rides the
 * host page's `auth.password.admin_reset` permission gate; the backend is the real authority and 403s.
 *
 * Deep links (the SECURITY_ALERT notification, old bookmarks) arrive as `?request=<id>` on the HOST
 * route: the section preselects that request once the list loads and scrolls its row into view. Later
 * same-page query-param navigations (another notification clicked while already here) re-preselect
 * without recreating the component.
 *
 * The list arrives PENDING-first straight from the API (server enum order) and is rendered as-is (no
 * client re-sort). Selecting a row loads the detail: the masked account, request/expiry timestamps, a
 * parsed device summary (+ collapsible raw user-agent) and a coarse network prefix — honestly labelled,
 * because the full IP is never stored. Approve/Deny each sit behind a ui-confirm-dialog whose copy
 * states the human part out loud: the ADMIN verifies the requester's identity out-of-band; approval
 * only lets the requesting browser set its own new password (no password is chosen or seen here).
 *
 * Decision failures render INLINE by stable code (`Auth.ResetRequestAlreadyDecided` /
 * `Auth.ResetRequestExpired` / `Auth.ResetRequestNotFound` → the list auto-refreshes so the stale row
 * heals; `Auth.SelfResetForbidden` reuses the shared catalog copy). Standalone + OnPush + signals.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { finalize } from 'rxjs/operators';
import {
  PasswordResetApi,
  ResetRequestDetail,
  ResetRequestItem,
} from '@core/api/password-reset.api';
import { extractApiError } from '@core/services/app-error.service';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { type RelativeTime, relativeTime } from '@shared/utils/relative-time.util';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiBadgeComponent, UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';

/**
 * The rendered lifecycle of a row. `completed` is presentation-only: an APPROVED request whose granted
 * challenge was already consumed (`completedAt` set) reads as finished, not merely approved.
 */
type DisplayStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'completed';

/** Static i18n keys per display status (no dynamic key building — i18n:check-visible). */
const STATUS_KEY: Record<DisplayStatus, string> = {
  pending: 'password.resetRequests.status.pending',
  approved: 'password.resetRequests.status.approved',
  denied: 'password.resetRequests.status.denied',
  expired: 'password.resetRequests.status.expired',
  completed: 'password.resetRequests.status.completed',
};

/** Badge colourways per display status (icon + label always accompany colour — never colour-only). */
const STATUS_BADGE: Record<DisplayStatus, UiBadgeColor> = {
  pending: 'yellow',
  approved: 'green',
  denied: 'red',
  expired: 'zinc',
  completed: 'teal',
};

/** Leading badge icon per display status (all already in the remixicon subset). */
const STATUS_ICON: Record<DisplayStatus, string> = {
  pending: 'ri-time-line',
  approved: 'ri-checkbox-circle-line',
  denied: 'ri-close-circle-line',
  expired: 'ri-history-line',
  completed: 'ri-shield-check-line',
};

@Component({
  selector: 'app-admin-reset-requests',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    TranslateModule,
    UiAlertComponent,
    UiBadgeComponent,
    UiButtonComponent,
    UiCardComponent,
    UiConfirmDialogComponent,
  ],
  templateUrl: './admin-reset-requests.component.html',
  styleUrl: './admin-reset-requests.component.scss',
})
export class AdminResetRequestsComponent {
  /** Reactive locale tag for template date pipes — live on language switch. */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly resetApi = inject(PasswordResetApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /** The request rows, in the server's PENDING-first order (rendered as-is, never re-sorted). */
  readonly items = signal<readonly ResetRequestItem[]>([]);
  /** True while the list is (re)loading. */
  readonly loading = signal(false);
  /** True when the list load itself failed — the screen then offers a retry. */
  readonly loadFailed = signal(false);
  /** The selected request's detail (null until a row is chosen or the `:id` preselect resolves). */
  readonly selected = signal<ResetRequestDetail | null>(null);
  /** True while a detail fetch is in flight. */
  readonly detailLoading = signal(false);
  /** True while an approve/deny decision is in flight (guards double submits + the dialog spinner). */
  readonly deciding = signal(false);
  /** Which decision the open confirm dialog is for (null = closed). */
  readonly confirmAction = signal<'approve' | 'deny' | null>(null);
  /** The inline error i18n key (null when none) — the single failure surface of this screen. */
  readonly errorKey = signal<string | null>(null);
  /** Whether the collapsible raw user-agent line is expanded on the detail panel. */
  readonly showRawUa = signal(false);

  /** Empty = loaded fine but no requests (distinct from the failed state). */
  readonly isEmpty = computed(
    () => !this.loading() && !this.loadFailed() && this.items().length === 0,
  );

  /** The last `?request=` id already preselected — guards the query-param stream against re-fetches. */
  private lastPreselectId: string | null = null;

  constructor() {
    // EK-2: a deep link `?request=<id>` on the HOST route (e.g. from the SECURITY_ALERT notification,
    // or a redirected legacy `/admin-reset-requests/:id` URL) preselects that request's detail once
    // the list has loaded, and scrolls its row into view.
    this.lastPreselectId = this.route.snapshot.queryParamMap.get('request');
    this.load(this.lastPreselectId, true);
    // Same-page navigations only change the query param (the component is NOT recreated), so later
    // `?request=` values re-preselect here; the initial emission is swallowed by lastPreselectId.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(params => {
      const id = params.get('request');
      if (!id || id === this.lastPreselectId) return;
      this.lastPreselectId = id;
      this.errorKey.set(null);
      this.fetchDetail(id, true);
    });
  }

  /**
   * Load (or reload) the list; optionally (re)select `preselectId`'s detail afterwards.
   * `scrollTo` additionally scrolls the preselected row into view (query-param deep links only —
   * refresh/decision reloads keep the viewport still).
   */
  load(preselectId?: string | null, scrollTo = false): void {
    this.loading.set(true);
    this.loadFailed.set(false);
    this.resetApi
      .listResetRequests()
      .pipe(
        finalize(() => this.loading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: items => {
          this.items.set(items);
          if (preselectId) this.fetchDetail(preselectId, scrollTo);
        },
        error: () => this.loadFailed.set(true),
      });
  }

  /** Toolbar refresh: reload the list and re-pull the currently selected detail (if any). */
  refresh(): void {
    this.errorKey.set(null);
    this.load(this.selected()?.id ?? null);
  }

  /** Row click: clear any stale error and load that request's detail. */
  selectRequest(item: ResetRequestItem): void {
    if (this.deciding()) return;
    this.errorKey.set(null);
    this.fetchDetail(item.id);
  }

  /** Ask to approve — only a PENDING, not-in-flight selection opens the dialog. */
  askApprove(): void {
    this.askDecision('approve');
  }

  /** Ask to deny — identical gating to {@link askApprove}. */
  askDeny(): void {
    this.askDecision('deny');
  }

  /** Close the confirm dialog without deciding. */
  cancelDecision(): void {
    if (this.deciding()) return;
    this.confirmAction.set(null);
  }

  /**
   * Confirmed: fire the decision. Success replaces the detail with the refreshed row the API returns
   * and quietly reloads the list (the PENDING-first order changes). Failures map by stable code.
   */
  confirmDecision(): void {
    const action = this.confirmAction();
    const current = this.selected();
    if (!action || !current || this.deciding()) return;
    this.confirmAction.set(null);
    this.deciding.set(true);
    this.errorKey.set(null);
    const decide$ =
      action === 'approve'
        ? this.resetApi.approveResetRequest(current.id)
        : this.resetApi.denyResetRequest(current.id);
    decide$
      .pipe(
        finalize(() => this.deciding.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: detail => {
          this.selected.set(detail);
          this.load(); // the row moved out of the PENDING block — re-pull the server order
        },
        error: (err: HttpErrorResponse) => this.applyDecisionError(err, current.id),
      });
  }

  /** Toggle the collapsible raw user-agent line on the detail panel. */
  toggleRawUa(): void {
    this.showRawUa.update(open => !open);
  }

  /** True when the selected request can still be decided (PENDING and not in flight). */
  canDecide(): boolean {
    return this.selected()?.status === 'PENDING' && !this.deciding();
  }

  // --- presentation helpers (static maps; no dynamic i18n keys) --------------------------------

  /** Collapse a row to its display status (`completed` when an APPROVED row was consumed). */
  displayStatus(item: Pick<ResetRequestItem, 'status' | 'completedAt'>): DisplayStatus {
    if (item.status === 'APPROVED' && item.completedAt) return 'completed';
    switch (item.status) {
      case 'PENDING':
        return 'pending';
      case 'APPROVED':
        return 'approved';
      case 'DENIED':
        return 'denied';
      default:
        return 'expired';
    }
  }

  statusKey(item: Pick<ResetRequestItem, 'status' | 'completedAt'>): string {
    return STATUS_KEY[this.displayStatus(item)];
  }

  statusColor(item: Pick<ResetRequestItem, 'status' | 'completedAt'>): UiBadgeColor {
    return STATUS_BADGE[this.displayStatus(item)];
  }

  statusIcon(item: Pick<ResetRequestItem, 'status' | 'completedAt'>): string {
    return STATUS_ICON[this.displayStatus(item)];
  }

  /**
   * Bucket an ISO timestamp into the shared relative-time shape (static key + params, or `absolute`
   * for ≥7 days) — the same idiom the notifications feed and the admin password-reset twin use.
   */
  requestedTime(iso: string): RelativeTime {
    return relativeTime(iso);
  }

  /** Open the confirm dialog for `action` when the selection is still decidable. */
  private askDecision(action: 'approve' | 'deny'): void {
    if (!this.canDecide()) return;
    this.errorKey.set(null);
    this.confirmAction.set(action);
  }

  /**
   * Fetch one request's detail; failures surface inline (generic — the row list stays usable).
   * `scrollTo` brings the row into view after the detail lands (query-param preselects only).
   */
  private fetchDetail(id: string, scrollTo = false): void {
    this.showRawUa.set(false);
    this.detailLoading.set(true);
    this.resetApi
      .getResetRequest(id)
      .pipe(
        finalize(() => this.detailLoading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: detail => {
          this.selected.set(detail);
          if (scrollTo) this.scrollRequestIntoView(id);
        },
        error: (err: HttpErrorResponse) => {
          this.selected.set(null);
          this.errorKey.set(
            this.errorCode(err) === 'Auth.ResetRequestNotFound'
              ? 'password.resetRequests.error.notFound'
              : 'password.resetRequests.error.generic',
          );
        },
      });
  }

  /**
   * Scroll the preselected request's row into view once the frame with the rendered list settles
   * (EK-2 — the section sits at the BOTTOM of the merged page, so a deep-linked request could be off
   * screen). `block: 'nearest'` keeps the movement minimal; guarded for SSR/headless (no `document`)
   * and for the row's absence (unknown/stale id), where it is simply a no-op.
   */
  private scrollRequestIntoView(id: string): void {
    if (typeof document === 'undefined') return;
    setTimeout(() => {
      document.querySelector(`[data-request-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  /**
   * Map a decision failure on request `id` to ONE localized inline message by stable code. The
   * staleness codes (already decided elsewhere / expired / gone) auto-refresh the list so the admin
   * immediately sees the current truth; a self-decision reuses the shared catalog copy; anything else
   * is generic.
   */
  private applyDecisionError(err: HttpErrorResponse, id: string): void {
    const code = this.errorCode(err);
    if (code === 'Auth.ResetRequestAlreadyDecided') {
      this.errorKey.set('password.resetRequests.error.alreadyDecided');
      this.load(id);
      return;
    }
    if (code === 'Auth.ResetRequestExpired') {
      this.errorKey.set('password.resetRequests.error.expired');
      this.load(id);
      return;
    }
    if (code === 'Auth.ResetRequestNotFound') {
      this.errorKey.set('password.resetRequests.error.notFound');
      this.selected.set(null);
      this.load();
      return;
    }
    if (code === 'Auth.SelfResetForbidden') {
      this.errorKey.set('errors.code.Auth.SelfResetForbidden');
      return;
    }
    this.errorKey.set('password.resetRequests.error.generic');
  }

  /** Read the stable `code` from the backend error envelope (`{ error: { code, message } }`). */
  private errorCode(err: HttpErrorResponse): string {
    const envelope = extractApiError(err.error);
    return typeof envelope?.code === 'string' ? envelope.code : '';
  }
}
