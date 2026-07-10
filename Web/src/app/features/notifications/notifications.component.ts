/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * The dedicated notifications page (`/notifications`). A full, paged, filterable history of
 * the operator's recipient-scoped notifications — replacing the old 8-item, timestamp-less header popup.
 * It renders ALL four states (loading skeletons / empty / error+retry / populated list), filters by
 * type / severity / read-state (server-applied), paginates via `app-ui-pagination`, marks rows read, and
 * deep-links a row to its subject. It stays live by subscribing to the recipient-scoped
 * `notification.created` SSE event (debounced) and re-pulling the current page; the shared
 * `NotificationStore` keeps the header badge in lock-step.
 *
 * Standalone + OnPush + signals + reactive filter controls. No PII/secret beyond the BE-allowlisted
 * `params`; type labels use a STATIC `type → key` map (no dynamic i18n keys).
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
  ViewChild,
  ElementRef,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { debounceTime } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';
import {
  AppNotification,
  NOTIFICATION_FALLBACK_BODY_KEY,
  NOTIFICATION_FALLBACK_TITLE_KEY,
  NotificationApi,
  NotificationQuery,
  NotificationSeverity,
  NotificationType,
  notificationText,
  notificationTypeIcon,
  notificationTypeKey,
} from '@core/api/notification.api';
import { NotificationStore } from '@core/state/notification.store';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';
import { UiSelectComponent } from '@shared/components/ui-select/ui-select.component';
import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import type { SelectOption } from '@shared/components/ui-form/ui-form.types';
import { relativeTime } from '@shared/utils/relative-time.util';

const PAGE_SIZE = 15;

/** STATIC severity → i18n key map (no dynamic key building, so `i18n:check` sees every key). */
const SEVERITY_KEY: Readonly<Record<NotificationSeverity, string>> = {
  info: 'notifications.severity.info',
  success: 'notifications.severity.success',
  warning: 'notifications.severity.warning',
  critical: 'notifications.severity.critical',
};

/** Severity → leading badge icon. The badge carries icon + label, so colour is never the only signal. */
const SEVERITY_ICON: Readonly<Record<NotificationSeverity, string>> = {
  info: 'ri-information-line',
  success: 'ri-checkbox-circle-line',
  warning: 'ri-alert-line',
  critical: 'ri-error-warning-line',
};

/**
 * STATIC notification TYPE → category-tile CSS class. The LEFT tile encodes the notification's
 * CATEGORY (account/security = blue, KYC = teal, customer = pink, system = yellow) — a DIFFERENT
 * fact from the RIGHT badge, which encodes SEVERITY. The SCSS (`notif-row__tile--{hue}`) owns the
 * `--tile-*`/`--color-*` tokens. Five enum types collapse onto four category hues (account + security
 * share the secure-blue family). Category is never colour-only: the row also carries the type glyph.
 */
const TYPE_TILE: Readonly<Record<NotificationType, string>> = {
  SECURITY_ALERT: 'notif-row__tile--blue',
  ACCOUNT: 'notif-row__tile--blue',
  KYC_EVENT: 'notif-row__tile--teal',
  CUSTOMER_EVENT: 'notif-row__tile--pink',
  SYSTEM: 'notif-row__tile--yellow',
};

/**
 * A resolved notification deep link: router commands + optional navigation extras (EK-2 — the
 * reset-request link needs a `?request=` query param, which plain commands cannot carry).
 */
interface NotificationLink {
  readonly commands: unknown[];
  readonly extras?: { queryParams: Record<string, string> };
}

/** One date-bucket of notifications for the grouped list (server order preserved within each bucket). */
interface NotificationGroup {
  /** Stable group id (also the `@for` track key). */
  readonly key: 'today' | 'earlier';
  /** The group label i18n key (static). */
  readonly labelKey: string;
  readonly items: readonly AppNotification[];
}

@Component({
  selector: 'app-notifications',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    TranslateModule,
    UiAlertComponent,
    UiButtonComponent,
    UiCardComponent,
    UiEmptyComponent,
    UiSelectComponent,
    UiSegmentedComponent,
    UiSkeletonComponent,
  ],
  templateUrl: './notifications.component.html',
  styleUrl: './notifications.component.scss',
})
export class NotificationsComponent implements OnInit {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly api = inject(NotificationApi);
  private readonly store = inject(NotificationStore);
  private readonly stream = inject(DashboardStreamService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly translate = inject(TranslateService);

  /** The current page of notifications. */
  readonly items = signal<readonly AppNotification[]>([]);
  /**
   * The recipient's real unread total (the shared store signal) — drives the summary-head line + the
   * mark-all guard. The store stays the single source of truth; this is a read-only re-export, never a
   * second copy.
   */
  readonly unreadCount = this.store.unreadCount;
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = PAGE_SIZE;
  readonly loading = signal(false);
  /** A13: an APPEND fetch is in flight (bottom skeletons; the initial `loading` keeps the full-list skeleton). */
  readonly loadingMore = signal(false);
  /** A13: every row of the current filter set is on screen — the sentinel/button give way to an end line. */
  readonly allLoaded = computed(() => this.total() > 0 && this.items().length >= this.total());

  /**
   * A13 infinite scroll: an IntersectionObserver on the bottom sentinel auto-triggers `loadMore()`
   * as the operator nears the end; the visible "load more" button stays as the keyboard/AT (and
   * no-IntersectionObserver) fallback. The setter re-arms whenever `@if` re-creates the sentinel.
   */
  @ViewChild('loadMoreSentinel') set loadMoreSentinel(ref: ElementRef<HTMLElement> | undefined) {
    this.sentinelObserver?.disconnect();
    if (!ref || typeof IntersectionObserver === 'undefined') return;
    this.sentinelObserver = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) this.loadMore();
      },
      { rootMargin: '240px 0px' },
    );
    this.sentinelObserver.observe(ref.nativeElement);
  }
  private sentinelObserver?: IntersectionObserver;
  /** True after a failed load (drives the error+retry block); cleared on the next attempt. */
  readonly errored = signal(false);
  /** The row whose mark-read is in flight (disables just that row's control). */
  readonly markingId = signal<string | null>(null);

  /** Filter controls (server-applied). Type/severity use SelectOption (static i18n keys); read uses segmented. */
  readonly typeControl = new FormControl<NotificationType | ''>('', { nonNullable: true });
  readonly severityControl = new FormControl<NotificationSeverity | ''>('', { nonNullable: true });
  readonly readControl = new FormControl<'all' | 'unread' | 'read'>('all', { nonNullable: true });

  // The 5 BE NotificationType enum values, each with a STATIC i18n label key.
  readonly typeOptions: ReadonlyArray<SelectOption> = [
    { labelKey: 'notifications.filter.allTypes', value: '' },
    { labelKey: 'notifications.type.securityAlert', value: 'SECURITY_ALERT' },
    { labelKey: 'notifications.type.kycEvent', value: 'KYC_EVENT' },
    { labelKey: 'notifications.type.customerEvent', value: 'CUSTOMER_EVENT' },
    { labelKey: 'notifications.type.system', value: 'SYSTEM' },
    { labelKey: 'notifications.type.account', value: 'ACCOUNT' },
  ];

  readonly severityOptions: ReadonlyArray<SelectOption> = [
    { labelKey: 'notifications.filter.allSeverities', value: '' },
    { labelKey: 'notifications.severity.info', value: 'info' },
    { labelKey: 'notifications.severity.success', value: 'success' },
    { labelKey: 'notifications.severity.warning', value: 'warning' },
    { labelKey: 'notifications.severity.critical', value: 'critical' },
  ];

  readonly readSegments: ReadonlyArray<UiSegmentItem> = [
    { value: 'all', labelKey: 'notifications.filter.all' },
    { value: 'unread', labelKey: 'notifications.filter.unread' },
    { value: 'read', labelKey: 'notifications.filter.read' },
  ];

  /** Stable skeleton placeholder rows for the loading state. */
  readonly skeletonRows = [0, 1, 2, 3, 4] as const;
  /** Shorter skeleton strip while APPENDING the next page (A13). */
  readonly loadMoreSkeletonRows = [0, 1, 2] as const;

  /**
   * Bucket the ALREADY-FETCHED current page into "today" (same calendar day as now) vs "earlier", purely
   * for visual grouping — it does NOT re-sort, re-query, or change the server's order WITHIN a bucket, and
   * only NON-EMPTY buckets are emitted. With every row in one bucket it degrades to a single group. A
   * `computed` over the `items()` signal (so it recomputes on each page/SSE reload). `today` is decided by
   * a same-calendar-day comparison against the current local date (recomputed per pass, not memoized).
   */
  readonly groups = computed<readonly NotificationGroup[]>(() => {
    const today: AppNotification[] = [];
    const earlier: AppNotification[] = [];
    const now = new Date();
    for (const item of this.items()) {
      (this.isToday(item.createdAt, now) ? today : earlier).push(item);
    }
    const out: NotificationGroup[] = [];
    if (today.length > 0) {
      out.push({ key: 'today', labelKey: 'notifications.group.today', items: today });
    }
    if (earlier.length > 0) {
      out.push({ key: 'earlier', labelKey: 'notifications.group.earlier', items: earlier });
    }
    return out;
  });

  /** True when `iso` falls on the same local calendar day as `now` (invalid/unparseable → not today). */
  private isToday(iso: string, now: Date): boolean {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return false;
    return (
      then.getFullYear() === now.getFullYear() &&
      then.getMonth() === now.getMonth() &&
      then.getDate() === now.getDate()
    );
  }

  /**
   * True when at least one filter is active (drives the empty-state "clear filters" affordance). A plain
   * method (NOT a computed) so the OnPush template re-reads the reactive-form values on each CD pass —
   * `FormControl.value` is not a signal, so a `computed` would memoize the first value.
   */
  hasActiveFilter(): boolean {
    return (
      !!this.typeControl.value || !!this.severityControl.value || this.readControl.value !== 'all'
    );
  }

  ngOnInit(): void {
    this.load();

    // Live (A13): a recipient-scoped `notification.created` event MERGES page 1 into the top of the
    // accumulated list (debounced to coalesce bursts) — new rows prepend consistently with the
    // unread-first order, and an already-extended scroll list is never collapsed back to one page.
    this.stream
      .connectNotifications()
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshTop());

    this.destroyRef.onDestroy(() => this.sentinelObserver?.disconnect());

    // Re-filter (and reset to page 1) whenever any filter changes.
    this.typeControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyFilters());
    this.severityControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyFilters());
    this.readControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyFilters());
  }

  /** Build the server query from the active filters + current page. */
  private query(): NotificationQuery {
    const q: NotificationQuery = { page: this.page(), pageSize: this.pageSize };
    if (this.typeControl.value) q.type = this.typeControl.value;
    if (this.severityControl.value) q.severity = this.severityControl.value;
    if (this.readControl.value === 'unread') q.read = false;
    if (this.readControl.value === 'read') q.read = true;
    return q;
  }

  /** RESET load (page 1, list replaced) — first paint, filter changes, retry, mark-all (A13). */
  load(): void {
    this.page.set(1);
    this.loading.set(true);
    this.errored.set(false);
    this.api
      .list(this.query())
      .pipe(
        catchError(() => {
          this.errored.set(true);
          return of(null);
        }),
        finalize(() => this.loading.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(result => {
        if (!result) return;
        this.items.set(result.data);
        this.total.set(result.page.total);
        // Keep the shared badge fresh from the same response's unreadCount.
        this.store.refresh();
      });
  }

  /** A filter changed: reset to page 1 and reload. */
  private applyFilters(): void {
    this.page.set(1);
    this.load();
  }

  /** Reset every filter to its default; the valueChanges subscriptions trigger the reload. */
  clearFilters(): void {
    this.typeControl.setValue('');
    this.severityControl.setValue('');
    this.readControl.setValue('all');
  }

  /**
   * A13: fetch the NEXT page and APPEND it (sentinel-triggered, or the fallback button). Appended
   * rows are de-duplicated by id (an SSE prepend may already carry the head of the next page).
   * A failed append rolls the page back so the button/sentinel can simply try again — the
   * accumulated list is never wiped for an append failure.
   */
  loadMore(): void {
    if (this.loading() || this.loadingMore() || this.errored() || this.allLoaded()) return;
    const nextPage = this.page() + 1;
    this.page.set(nextPage);
    this.loadingMore.set(true);
    this.api
      .list(this.query())
      .pipe(
        catchError(() => {
          this.page.set(nextPage - 1); // roll back so the next trigger retries the same page
          return of(null);
        }),
        finalize(() => this.loadingMore.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(result => {
        if (!result) return;
        this.items.update(prev => [
          ...prev,
          ...result.data.filter(item => !prev.some(existing => existing.id === item.id)),
        ]);
        this.total.set(result.page.total);
        this.store.refresh();
      });
  }

  /**
   * A13 SSE merge: re-pull PAGE 1 with the active filters, refresh any rows we already hold (e.g. a
   * readAt flipped elsewhere), and PREPEND the genuinely new ones — consistent with the
   * unread-first, newest-first order without collapsing an extended list. Errors are ignored here
   * (the shared badge store self-heals; the next SSE tick retries).
   */
  private refreshTop(): void {
    const query = { ...this.query(), page: 1 };
    this.api
      .list(query)
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(result => {
        if (!result) return;
        const freshById = new Map(result.data.map(item => [item.id, item]));
        this.items.update(prev => {
          const refreshedPrev = prev.map(item => freshById.get(item.id) ?? item);
          const newOnes = result.data.filter(
            item => !prev.some(existing => existing.id === item.id),
          );
          return [...newOnes, ...refreshedPrev];
        });
        this.total.set(result.page.total);
        this.store.refresh();
      });
  }

  /** Read-state segmented change (string → the typed control). */
  onReadChange(value: string): void {
    this.readControl.setValue(value === 'unread' ? 'unread' : value === 'read' ? 'read' : 'all');
  }

  /** Activate a row: mark it read (if unread), then deep-link to its subject when it has one. */
  onRowClick(item: AppNotification): void {
    if (!item.readAt) this.markRead(item, false);
    const target = this.routeFor(item);
    if (target) void this.router.navigate(target.commands, target.extras);
  }

  /**
   * Mark one row read. Optimistic: flip `readAt` locally so the row de-emphasises immediately, then call
   * the API (which the shared store re-pulls for the badge). `stop` prevents a row click when the mark-read
   * control is clicked directly. On failure the optimistic flip is rolled back.
   */
  markRead(item: AppNotification, stop: boolean, event?: Event): void {
    if (stop) event?.stopPropagation();
    if (item.readAt || this.markingId() === item.id) return;
    const stampedAt = new Date().toISOString();
    this.patchReadAt(item.id, stampedAt);
    this.markingId.set(item.id);
    this.api
      .markRead(item.id)
      .pipe(
        finalize(() => this.markingId.set(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => this.store.refresh(),
        error: () => this.patchReadAt(item.id, null), // rollback
      });
  }

  /** Mark every unread notification read, then reload the page + the shared badge. */
  markAll(): void {
    this.store.markAll();
    this.load();
  }

  /** Apply a `readAt` value to one row in the list (optimistic update / rollback). */
  private patchReadAt(id: string, readAt: string | null): void {
    this.items.update(list => list.map(n => (n.id === id ? { ...n, readAt } : n)));
  }

  /** Map a notification to its deep link (commands + extras), or null when it has no navigable subject. */
  private routeFor(item: AppNotification): NotificationLink | null {
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

  /** True when the row deep-links to a subject — drives the trailing "kayda git" (→) action on read rows. */
  hasRoute(item: AppNotification): boolean {
    return this.routeFor(item) !== null;
  }

  /** Trailing "kayda git" action: deep-link to the subject, without bubbling to the row button. */
  openRecord(item: AppNotification, event: Event): void {
    event.stopPropagation();
    const target = this.routeFor(item);
    if (target) void this.router.navigate(target.commands, target.extras);
  }

  // --- presentation helpers (static maps) --------------------------------------
  typeKey(type: string): string {
    return notificationTypeKey(type);
  }
  typeIcon(type: string): string {
    return notificationTypeIcon(type);
  }
  severityKey(severity: NotificationSeverity): string {
    return SEVERITY_KEY[severity] ?? 'notifications.severity.info';
  }
  /** The category-tile colourway class for a row's icon tile — encodes the notification TYPE, not severity. */
  typeTile(type: string): string {
    return TYPE_TILE[type as NotificationType] ?? 'notif-row__tile--blue';
  }
  /** The leading icon for a row's severity badge (badge = icon + label, never colour-only). */
  severityIcon(severity: NotificationSeverity): string {
    return SEVERITY_ICON[severity] ?? SEVERITY_ICON.info;
  }
  time(createdAt: string): { key: string; params: Record<string, number>; absolute: boolean } {
    return relativeTime(createdAt);
  }

  /** The BE titleKey resolved to text, with a safe fallback if the FE bundle lacks that key. */
  title(item: AppNotification): string {
    return notificationText(
      this.translate,
      item.titleKey,
      item.params,
      NOTIFICATION_FALLBACK_TITLE_KEY,
    );
  }
  /** The BE bodyKey resolved to text, with a safe fallback if the FE bundle lacks that key. */
  body(item: AppNotification): string {
    return notificationText(
      this.translate,
      item.bodyKey,
      item.params,
      NOTIFICATION_FALLBACK_BODY_KEY,
    );
  }
}
