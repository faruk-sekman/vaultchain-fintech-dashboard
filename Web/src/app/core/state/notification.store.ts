/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Shared live notification state for the header dropdown badge + the dropdown's recent
 * list. A small signal store (`providedIn: 'root'`) so the header and the `/notifications` page read ONE
 * source of truth — never two diverging copies. It loads the latest page once, then stays live by
 * subscribing to the recipient-scoped `notification.created` SSE event (debounced, like the dashboard's
 * customer-event pattern) and re-pulling the head of the list + the real `unreadCount`.
 *
 * Read-state is the BACKEND's: `markRead`/`markAll` call the API and then re-pull, so a reload is
 * consistent and the badge persists. Optimistic UI is intentionally avoided here (the dropdown is small
 * and the re-pull is cheap) to keep the count honest. No PII/secret is held — only the BE-allowlisted
 * rows the API already masks.
 */
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, debounceTime } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { AppNotification, NotificationApi } from '@core/api/notification.api';
import { DashboardStreamService } from '@core/realtime/dashboard-stream.service';

/** How many rows the header dropdown shows (the page route shows the full paged history). */
const DROPDOWN_LIMIT = 6;

@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly api = inject(NotificationApi);
  private readonly stream = inject(DashboardStreamService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _recent = signal<readonly AppNotification[]>([]);
  private readonly _unreadCount = signal(0);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);

  /** The most-recent notifications for the dropdown (newest first), capped at {@link DROPDOWN_LIMIT}. */
  readonly recent = this._recent.asReadonly();
  /** The recipient's real unread total (drives the badge; 0 hides the dot). */
  readonly unreadCount = this._unreadCount.asReadonly();
  readonly loading = this._loading.asReadonly();
  /** True once the first load has settled (so the dropdown shows empty, not a perpetual spinner). */
  readonly loaded = this._loaded.asReadonly();
  /** Whether there is at least one unread row (textual/colour-independent badge gate). */
  readonly hasUnread = computed(() => this._unreadCount() > 0);

  /** Start the live feed exactly once (idempotent): load the head, then subscribe to SSE. */
  init(): void {
    if (this._loaded() || this._loading()) {
      // Already loading/loaded — still ensure the badge is fresh on a re-entry.
      if (this._loaded()) this.refresh();
      return;
    }
    this.refresh();
    this.stream
      .connectNotifications()
      .pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
  }

  /** Re-pull the head of the list + the real unread count. Failures leave the prior rows intact. */
  refresh(): void {
    this._loading.set(true);
    this.api
      .list({ page: 1, pageSize: DROPDOWN_LIMIT })
      .pipe(
        // `finalize` settles BOTH flags on every terminal (next/complete OR the swallowed error), so
        // `loading` never sticks and `loaded` always flips — without the premature synchronous reset a
        // post-subscribe set would cause on a real async response.
        finalize(() => {
          this._loading.set(false);
          this._loaded.set(true);
        }),
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: result => {
          this._recent.set(result.data);
          this._unreadCount.set(result.unreadCount);
        },
      });
  }

  /** Mark one notification read, then re-pull so the badge + dropdown reflect the new state. */
  markRead(id: string): void {
    this.api
      .markRead(id)
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ next: () => this.refresh() });
  }

  /** Mark every unread notification read, then re-pull. */
  markAll(): void {
    this.api
      .markAll()
      .pipe(
        catchError(() => EMPTY),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ next: () => this.refresh() });
  }
}
