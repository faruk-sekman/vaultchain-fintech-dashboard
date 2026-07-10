/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Typed client for the real operator notification domain. This
 * REPLACES the old audit-log-shadow feed (`OperatorApi.listNotifications`, which returned the actor's
 * last audit rows with no real read-state). The backend is recipient-scoped: a request only ever returns
 * the caller's own notifications (FE filtering is NOT a security control — the BE scoping is).
 *
 *   list(query)            → GET /operator/notifications. BRACKET query params (page[number]/page[size]/
 *                            filter[type]/filter[severity]/filter[read]); SINGLE-level envelope
 *                            { data, page:{number,size,totalItems,totalPages}, unreadCount }, flattened here.
 *   markRead(id)           → POST /operator/notifications/{id}/read. Idempotent; returns { unreadCount }.
 *   markAll()              → POST /operator/notifications/read-all. Returns the new { unreadCount }.
 *
 * The live `notification.created` SSE event is consumed via `DashboardStreamService`, not here. No PII
 * or secret is rendered beyond the BE-allowlisted `params`; the type label uses a STATIC key map (below)
 * so the i18n gate can see every key (no key is ever built from a dynamic string).
 */
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';
import type { PageEvent } from '@shared/components/ui-table/ui-table.types';

/**
 * The notification `type` enum — EXACTLY the backend Prisma `NotificationType`:
 * `enum NotificationType { SECURITY_ALERT KYC_EVENT CUSTOMER_EVENT SYSTEM ACCOUNT }`. A CLOSED union so
 * the FE maps each to a static i18n key + icon; an unknown type from the wire falls back to the generic
 * label/icon (never crashes — forward-compatible with a future BE type).
 */
export type NotificationType =
  | 'SECURITY_ALERT'
  | 'KYC_EVENT'
  | 'CUSTOMER_EVENT'
  | 'SYSTEM'
  | 'ACCOUNT';

/** Severity drives the row accent + badge colour (never the ONLY signal — text/icon carry it too). */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

/**
 * One notification row — mirrors the backend `NotificationItemDto` EXACTLY. `titleKey`/`bodyKey` are
 * i18n keys the BE chose; `params` is a BE-allowlisted, PII-free interpolation bag (`unknown` values,
 * as the BE types it). `resourceType` is always present (non-null); `resourceId` may be null. `readAt`
 * is null until read.
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  titleKey: string;
  bodyKey: string;
  params: Record<string, unknown> | null;
  resourceType: string;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * The internal FE paged shape — the page meta is FLATTENED from the BE envelope (see {@link list}). The
 * BE returns `page: { number, size, totalItems, totalPages }`; we keep a compact `{ page, pageSize, total }`
 * for the existing ui-pagination wiring.
 */
export interface NotificationPage {
  data: AppNotification[];
  page: { page: number; pageSize: number; total: number };
  unreadCount: number;
}

/** Optional list filters; all server-applied via BRACKET query params (see {@link list}). */
export interface NotificationQuery {
  page?: number;
  pageSize?: number;
  type?: NotificationType;
  severity?: NotificationSeverity;
  read?: boolean;
}

/** The raw single-level BE envelope (`PaginatedNotificationListDto`), before flattening. */
interface BackendNotificationList {
  data: AppNotification[];
  page: { number: number; size: number; totalItems: number; totalPages: number };
  unreadCount: number;
}

/**
 * STATIC `type → i18n key` map (replaces the old dynamic key building). Keyed by the BE's five enum
 * values. Static so `i18n:check` sees every key; an unknown type resolves to the generic key via
 * {@link notificationTypeKey}.
 */
export const NOTIFICATION_TYPE_KEY: Readonly<Record<NotificationType, string>> = {
  SECURITY_ALERT: 'notifications.type.securityAlert',
  KYC_EVENT: 'notifications.type.kycEvent',
  CUSTOMER_EVENT: 'notifications.type.customerEvent',
  SYSTEM: 'notifications.type.system',
  ACCOUNT: 'notifications.type.account',
};

/** STATIC `type → remix-icon` map (presentation only; colour-independent affordance). */
export const NOTIFICATION_TYPE_ICON: Readonly<Record<NotificationType, string>> = {
  SECURITY_ALERT: 'ri-error-warning-line',
  KYC_EVENT: 'ri-shield-check-line',
  CUSTOMER_EVENT: 'ri-user-settings-line',
  SYSTEM: 'ri-information-line',
  ACCOUNT: 'ri-account-circle-line',
};

/** The fallback key/icon for an unrecognised type (forward-compatible with a new BE type). */
export const NOTIFICATION_FALLBACK_KEY = 'notifications.type.activity';
export const NOTIFICATION_FALLBACK_ICON = 'ri-notification-3-line';

/** Resolve a type's label key, defaulting to the generic key for an unknown type. */
export function notificationTypeKey(type: string): string {
  return NOTIFICATION_TYPE_KEY[type as NotificationType] ?? NOTIFICATION_FALLBACK_KEY;
}

/** Resolve a type's icon, defaulting to the generic icon for an unknown type. */
export function notificationTypeIcon(type: string): string {
  return NOTIFICATION_TYPE_ICON[type as NotificationType] ?? NOTIFICATION_FALLBACK_ICON;
}

/** The minimal translate surface the body/title fallback needs (so callers can pass a stub in tests). */
export interface NotificationTranslator {
  instant(key: string, params?: Record<string, unknown>): string;
}

/**
 * Resolve a BE-supplied `titleKey`/`bodyKey` to display text, with a SAFE fallback: the BE owns its own
 * key set, so an UNWIRED future event could send a key the FE bundle lacks. ngx-translate returns the key
 * verbatim when it is missing — we detect that (resolved === key) and substitute `fallbackKey` so an
 * operator never sees a raw `notifications.x.y` string. The fallback key itself is a static, always-present
 * FE key.
 */
export function notificationText(
  translate: NotificationTranslator,
  key: string,
  params: Record<string, unknown> | null,
  fallbackKey: string,
): string {
  const resolved = translate.instant(key, params ?? undefined);
  // Missing key → ngx-translate echoes the key back; fall back to the generic FE copy.
  if (!resolved || resolved === key) return translate.instant(fallbackKey);
  return resolved;
}

/** Static fallback keys for an unknown/unwired title or body. */
export const NOTIFICATION_FALLBACK_TITLE_KEY = 'notifications.fallback.title';
export const NOTIFICATION_FALLBACK_BODY_KEY = 'notifications.fallback.body';

@Injectable({ providedIn: 'root' })
export class NotificationApi {
  private readonly api = inject(ApiClientService);

  /**
   * Fetch a page of the caller's notifications (recipient-scoped server-side). Filters are optional and
   * sent as BRACKET params (`page[number]`/`page[size]`/`filter[type]`/`filter[severity]`/`filter[read]`)
   * to match the BE query parser; an out-of-range `page[size]` is a 400 (the BE rejects, not clamps). The
   * single-level `{ data, page:{number,size,totalItems,totalPages}, unreadCount }` body is FLATTENED into
   * the compact internal {@link NotificationPage} shape the UI consumes.
   */
  list(query: NotificationQuery = {}): Observable<NotificationPage> {
    const params: Record<string, string | number | boolean> = {};
    if (query.page != null) params['page[number]'] = query.page;
    if (query.pageSize != null) params['page[size]'] = query.pageSize;
    if (query.type) params['filter[type]'] = query.type;
    if (query.severity) params['filter[severity]'] = query.severity;
    if (query.read != null) params['filter[read]'] = query.read;
    return this.api.get<BackendNotificationList>('/operator/notifications', params).pipe(
      map(res => ({
        data: res.data,
        page: { page: res.page.number, pageSize: res.page.size, total: res.page.totalItems },
        unreadCount: res.unreadCount,
      })),
    );
  }

  /** Mark a single notification read (idempotent server-side); resolves the recipient's new unread count. */
  markRead(id: string): Observable<number> {
    return this.api
      .post<{ data: { unreadCount: number } }>(`/operator/notifications/${id}/read`, {})
      .pipe(map(res => res.data.unreadCount));
  }

  /** Mark every unread notification read; resolves the recipient's new unread count (0). */
  markAll(): Observable<number> {
    return this.api
      .post<{ data: { unreadCount: number } }>('/operator/notifications/read-all', {})
      .pipe(map(res => res.data.unreadCount));
  }
}

/** Re-export so list components can reuse the shared `PageEvent` shape without a second import path. */
export type { PageEvent };
