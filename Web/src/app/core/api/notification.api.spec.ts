/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Seam test for NotificationApi (aligned to the REAL contract). Mocks
 * ApiClientService and locks the contract: BRACKET query params (page[number]/page[size]/filter[*]); the
 * SINGLE-level `{ data, page:{number,size,totalItems,totalPages}, unreadCount }` envelope flattened to the
 * compact internal shape; mark-read / mark-all returning `{ unreadCount }`; the STATIC type → key / icon
 * maps over the BE's FIVE enum values + their fallbacks; and the titleKey/bodyKey safe-fallback helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, lastValueFrom } from 'rxjs';
import { ApiClientService } from './api-client.service';
import {
  NOTIFICATION_FALLBACK_ICON,
  NOTIFICATION_FALLBACK_KEY,
  NOTIFICATION_TYPE_ICON,
  NOTIFICATION_TYPE_KEY,
  NotificationApi,
  notificationText,
  notificationTypeIcon,
  notificationTypeKey,
} from './notification.api';

/** The REAL single-level BE envelope (page meta = {number,size,totalItems,totalPages}). */
const BE_PAGE = {
  data: [],
  page: { number: 1, size: 20, totalItems: 0, totalPages: 0 },
  unreadCount: 0,
};

describe('NotificationApi (real contract)', () => {
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let svc: NotificationApi;

  beforeEach(() => {
    api = {
      get: vi.fn(() => of(BE_PAGE)),
      post: vi.fn(() => of({ data: { unreadCount: 0 } })),
    };
    TestBed.configureTestingModule({
      providers: [NotificationApi, { provide: ApiClientService, useValue: api }],
    });
    svc = TestBed.inject(NotificationApi);
  });

  it('list() GETs /operator/notifications and FLATTENS the single-level page envelope', async () => {
    const res = await lastValueFrom(svc.list().pipe());
    const [path, params] = api.get.mock.calls[0];
    expect(path).toBe('/operator/notifications');
    expect(params).toEqual({}); // no filters → no params
    // page {number,size,totalItems} → {page,pageSize,total}
    expect(res.page).toEqual({ page: 1, pageSize: 20, total: 0 });
    expect(res.unreadCount).toBe(0);
  });

  it('list() forwards filters as BRACKET params (page[number]/page[size]/filter[*])', () => {
    void svc
      .list({ page: 2, pageSize: 15, type: 'KYC_EVENT', severity: 'critical', read: false })
      .subscribe();
    const [, params] = api.get.mock.calls[0];
    expect(params).toEqual({
      'page[number]': 2,
      'page[size]': 15,
      'filter[type]': 'KYC_EVENT',
      'filter[severity]': 'critical',
      'filter[read]': false,
    });
  });

  it('list() omits an undefined read filter (both read + unread)', () => {
    void svc.list({ page: 1 }).subscribe();
    const [, params] = api.get.mock.calls[0];
    expect(params).toEqual({ 'page[number]': 1 });
    expect(params).not.toHaveProperty('filter[read]');
  });

  it('markRead() POSTs to the per-id read path and resolves the new unreadCount', async () => {
    api.post.mockReturnValueOnce(of({ data: { unreadCount: 4 } }));
    const count = await lastValueFrom(svc.markRead('abc'));
    expect(api.post).toHaveBeenCalledWith('/operator/notifications/abc/read', {});
    expect(count).toBe(4);
  });

  it('markAll() POSTs to the read-all path and resolves the new unreadCount', async () => {
    api.post.mockReturnValueOnce(of({ data: { unreadCount: 0 } }));
    const count = await lastValueFrom(svc.markAll());
    expect(api.post).toHaveBeenCalledWith('/operator/notifications/read-all', {});
    expect(count).toBe(0);
  });

  it('the static type → key map covers EXACTLY the BE enum (5 values) and aligns with the icon map', () => {
    expect(Object.keys(NOTIFICATION_TYPE_KEY).sort()).toEqual(
      ['ACCOUNT', 'CUSTOMER_EVENT', 'KYC_EVENT', 'SECURITY_ALERT', 'SYSTEM'].sort(),
    );
    expect(NOTIFICATION_TYPE_KEY['KYC_EVENT']).toBe('notifications.type.kycEvent');
    expect(NOTIFICATION_TYPE_KEY['SECURITY_ALERT']).toBe('notifications.type.securityAlert');
    expect(Object.keys(NOTIFICATION_TYPE_KEY)).toEqual(Object.keys(NOTIFICATION_TYPE_ICON));
  });

  it('notificationTypeKey/Icon fall back for an unknown type (forward-compatible)', () => {
    expect(notificationTypeKey('BRAND_NEW_TYPE')).toBe(NOTIFICATION_FALLBACK_KEY);
    expect(notificationTypeIcon('BRAND_NEW_TYPE')).toBe(NOTIFICATION_FALLBACK_ICON);
    expect(notificationTypeKey('CUSTOMER_EVENT')).toBe('notifications.type.customerEvent');
  });

  it('notificationText resolves a known key (with params) verbatim', () => {
    const translate = {
      instant: (k: string, p?: Record<string, unknown>) => (k === 'a.title' ? `Hi ${p?.['n']}` : k),
    };
    expect(notificationText(translate, 'a.title', { n: 'X' }, 'fb.title')).toBe('Hi X');
  });

  it('notificationText falls back when the key is MISSING (translate echoes the key)', () => {
    // A missing key → ngx-translate returns the key unchanged; the helper substitutes the fallback.
    const translate = { instant: (k: string) => (k === 'fb.title' ? 'Notification' : k) };
    expect(notificationText(translate, 'notifications.unwired.title', null, 'fb.title')).toBe(
      'Notification',
    );
  });
});
