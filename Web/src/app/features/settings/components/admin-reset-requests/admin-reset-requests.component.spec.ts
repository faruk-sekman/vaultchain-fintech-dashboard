/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Spec for the password-reset request review SECTION (A15/A16, merged into the admin-password-reset
 * page per EK-2). Covers: the initial list load in the server's PENDING-first order (rendered as-is,
 * never re-sorted), the `?request=` query-param deep-link preselect (+ scroll-into-view and its
 * SSR/absence guards, and later same-page query-param changes), row selection loading the detail, the
 * approve/deny confirm-dialog flow (no call before confirm), the stable-code → inline-message mapping
 * with the staleness auto-refresh (AlreadyDecided/Expired/NotFound) and the shared SelfResetForbidden
 * catalog copy, the empty/failed list states, the display-status collapse (`completed`), and the
 * raw-UA toggle. The API seam (paths/SILENT_REQUEST/cookie rules) is locked separately in
 * password-reset.api.spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, ParamMap, convertToParamMap } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';
import {
  PasswordResetApi,
  ResetRequestDetail,
  ResetRequestItem,
} from '@core/api/password-reset.api';
import { AdminResetRequestsComponent } from './admin-reset-requests.component';
import requestsTemplate from './admin-reset-requests.component.html?raw';

function item(over: Partial<ResetRequestItem> = {}): ResetRequestItem {
  return {
    id: 'req-1',
    account: { displayName: 'Audit Auditor', emailMasked: 'a***@s***.local' },
    status: 'PENDING',
    createdAt: '2026-07-01T10:00:00.000Z',
    expiresAt: '2026-07-02T10:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    completedAt: null,
    ...over,
  };
}

function detail(over: Partial<ResetRequestDetail> = {}): ResetRequestDetail {
  return {
    ...item(),
    ipPrefix: '203.0.113.0/24',
    deviceSummary: 'Chrome on macOS',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    ...over,
  };
}

/** The server's PENDING-first order: enum position first, newest inside each block. */
const SEED: ResetRequestItem[] = [
  item(),
  item({ id: 'req-2', status: 'APPROVED', decidedAt: '2026-07-01T11:00:00.000Z' }),
  item({ id: 'req-3', status: 'DENIED', decidedByName: 'Op Admin' }),
];

function apiError(status: number, code?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: code ? { error: { code, message: code } } : undefined,
  });
}

function setup(
  options: {
    requestId?: string | null;
    list?: unknown;
    detail?: unknown;
  } = {},
) {
  TestBed.resetTestingModule(); // some tests set up twice (e.g. the SSR-guard pair)
  const api = {
    listResetRequests: vi.fn(() => (options.list as never) ?? of(SEED)),
    getResetRequest: vi.fn(() => (options.detail as never) ?? of(detail())),
    approveResetRequest: vi.fn(() => of(detail({ status: 'APPROVED' }))),
    denyResetRequest: vi.fn(() => of(detail({ status: 'DENIED' }))),
  };
  // EK-2: the section reads the `?request=` QUERY param off the HOST route (admin-password-reset).
  // A BehaviorSubject mirrors the real queryParamMap (replays the current value on subscribe, so the
  // constructor's lastPreselectId guard against a double initial fetch is genuinely exercised).
  const queryParamMap$ = new BehaviorSubject<ParamMap>(
    convertToParamMap(options.requestId ? { request: options.requestId } : {}),
  );
  const route = {
    snapshot: {
      get queryParamMap() {
        return queryParamMap$.value;
      },
    },
    queryParamMap: queryParamMap$.asObservable(),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PasswordResetApi, useValue: api },
      { provide: ActivatedRoute, useValue: route },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new AdminResetRequestsComponent());
  return { component, api, queryParamMap$ };
}

describe('AdminResetRequestsComponent (A15/A16, EK-2 embedded section)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the list on construct and renders the server order AS-IS (PENDING-first passthrough)', () => {
    const { component, api } = setup();
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
    // No client re-sort: the ids appear exactly as the API returned them.
    expect(component.items().map(i => i.id)).toEqual(['req-1', 'req-2', 'req-3']);
    expect(component.loading()).toBe(false);
    expect(component.loadFailed()).toBe(false);
    expect(component.isEmpty()).toBe(false);
    expect(component.selected()).toBeNull(); // nothing preselected without a ?request=
  });

  it('preselects the ?request= query param ONCE the list has loaded (notification deep link, EK-2)', () => {
    const { component, api } = setup({ requestId: 'req-2' });
    expect(api.getResetRequest).toHaveBeenCalledWith('req-2');
    expect(api.getResetRequest).toHaveBeenCalledTimes(1); // the replayed initial emission is swallowed
    expect(component.selected()).not.toBeNull();
  });

  it('scrolls the preselected row into view (block nearest) once its detail lands', () => {
    vi.useFakeTimers();
    const rowEl = document.createElement('button');
    rowEl.setAttribute('data-request-id', 'req-2');
    const scrollIntoView = vi.fn();
    (rowEl as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    document.body.appendChild(rowEl);
    try {
      setup({ requestId: 'req-2' });
      vi.runAllTimers();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      rowEl.remove();
    }
  });

  it('the scroll is a safe no-op when the row is absent or document is unavailable (SSR guard)', () => {
    vi.useFakeTimers();
    // Absent row: querySelector finds nothing → optional chaining swallows the scroll.
    setup({ requestId: 'req-2' });
    expect(() => vi.runAllTimers()).not.toThrow();

    // SSR/headless: no `document` at all → the guard returns before scheduling anything.
    vi.stubGlobal('document', undefined);
    expect(() => setup({ requestId: 'req-3' })).not.toThrow();
    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('a LATER ?request= change re-preselects without recreating the component (same-page navigation)', () => {
    const { component, api, queryParamMap$ } = setup({ requestId: 'req-2' });
    api.getResetRequest.mockClear();
    component.errorKey.set('password.resetRequests.error.generic');

    queryParamMap$.next(convertToParamMap({ request: 'req-3' }));
    expect(component.errorKey()).toBeNull(); // stale inline errors cleared for the new preselect
    expect(api.getResetRequest).toHaveBeenCalledWith('req-3');
    expect(api.getResetRequest).toHaveBeenCalledTimes(1);

    // Re-emitting the SAME id (or dropping the param) never re-fetches.
    queryParamMap$.next(convertToParamMap({ request: 'req-3' }));
    queryParamMap$.next(convertToParamMap({}));
    expect(api.getResetRequest).toHaveBeenCalledTimes(1);
  });

  it('an empty list flips the dedicated empty state (distinct from failure)', () => {
    const { component } = setup({ list: of([]) });
    expect(component.isEmpty()).toBe(true);
    expect(component.loadFailed()).toBe(false);
  });

  it('a failed list load flips loadFailed (retry surface), not the empty state', () => {
    const { component } = setup({ list: throwError(() => apiError(500)) });
    expect(component.loadFailed()).toBe(true);
    expect(component.isEmpty()).toBe(false);
  });

  it('selecting a row clears stale errors and loads that detail', () => {
    const { component, api } = setup();
    component.errorKey.set('password.resetRequests.error.generic');
    component.selectRequest(SEED[0]);
    expect(component.errorKey()).toBeNull();
    expect(api.getResetRequest).toHaveBeenCalledWith('req-1');
    expect(component.selected()?.id).toBe('req-1');
    expect(component.detailLoading()).toBe(false);
  });

  it('a detail fetch failure clears the selection and shows the generic inline message', () => {
    const { component } = setup({ detail: throwError(() => apiError(500)) });
    component.selectRequest(SEED[0]);
    expect(component.selected()).toBeNull();
    expect(component.errorKey()).toBe('password.resetRequests.error.generic');
  });

  it('a 404 on the detail fetch maps to the notFound inline message', () => {
    const { component } = setup({
      detail: throwError(() => apiError(404, 'Auth.ResetRequestNotFound')),
    });
    component.selectRequest(SEED[0]);
    expect(component.errorKey()).toBe('password.resetRequests.error.notFound');
  });

  it('askApprove/askDeny open the confirm dialog ONLY for a PENDING selection — no call yet', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]); // PENDING detail
    component.askApprove();
    expect(component.confirmAction()).toBe('approve');
    expect(api.approveResetRequest).not.toHaveBeenCalled();

    component.cancelDecision();
    expect(component.confirmAction()).toBeNull();

    component.askDeny();
    expect(component.confirmAction()).toBe('deny');
    expect(api.denyResetRequest).not.toHaveBeenCalled();
  });

  it('a non-PENDING selection cannot open the decision dialog (canDecide gate)', () => {
    const { component } = setup({ detail: of(detail({ status: 'DENIED' })) });
    component.selectRequest(SEED[2]);
    expect(component.canDecide()).toBe(false);
    component.askApprove();
    expect(component.confirmAction()).toBeNull();
  });

  it('confirmed approve calls the API, swaps in the refreshed detail, and re-pulls the list order', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.listResetRequests.mockClear();
    component.askApprove();
    component.confirmDecision();
    expect(api.approveResetRequest).toHaveBeenCalledWith('req-1');
    expect(component.selected()?.status).toBe('APPROVED');
    expect(component.confirmAction()).toBeNull();
    expect(component.deciding()).toBe(false);
    expect(api.listResetRequests).toHaveBeenCalledTimes(1); // the row left the PENDING block
  });

  it('confirmed deny follows the identical contract', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    component.askDeny();
    component.confirmDecision();
    expect(api.denyResetRequest).toHaveBeenCalledWith('req-1');
    expect(component.selected()?.status).toBe('DENIED');
  });

  it('confirmDecision is a no-op with no open dialog and guards double submits in flight', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    component.confirmDecision(); // nothing confirmed → nothing happens
    expect(api.approveResetRequest).not.toHaveBeenCalled();

    api.approveResetRequest.mockReturnValueOnce(NEVER as never);
    component.askApprove();
    component.confirmDecision();
    expect(component.deciding()).toBe(true);
    component.askApprove(); // dialog cannot reopen mid-flight
    expect(component.confirmAction()).toBeNull();
    component.confirmDecision(); // and no stacked call
    expect(api.approveResetRequest).toHaveBeenCalledTimes(1);
  });

  it('Auth.ResetRequestAlreadyDecided → its inline copy + an automatic list refresh', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.listResetRequests.mockClear();
    api.approveResetRequest.mockReturnValueOnce(
      throwError(() => apiError(409, 'Auth.ResetRequestAlreadyDecided')) as never,
    );
    component.askApprove();
    component.confirmDecision();
    expect(component.errorKey()).toBe('password.resetRequests.error.alreadyDecided');
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
    // The refresh re-pulled the (kept) selection's detail so the admin sees the current truth.
    expect(api.getResetRequest).toHaveBeenLastCalledWith('req-1');
  });

  it('Auth.ResetRequestExpired → its inline copy + an automatic list refresh', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.listResetRequests.mockClear();
    api.denyResetRequest.mockReturnValueOnce(
      throwError(() => apiError(409, 'Auth.ResetRequestExpired')) as never,
    );
    component.askDeny();
    component.confirmDecision();
    expect(component.errorKey()).toBe('password.resetRequests.error.expired');
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
  });

  it('Auth.ResetRequestNotFound on decide → notFound copy, selection cleared, list refreshed', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.listResetRequests.mockClear();
    api.approveResetRequest.mockReturnValueOnce(
      throwError(() => apiError(404, 'Auth.ResetRequestNotFound')) as never,
    );
    component.askApprove();
    component.confirmDecision();
    expect(component.errorKey()).toBe('password.resetRequests.error.notFound');
    expect(component.selected()).toBeNull();
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
  });

  it('Auth.SelfResetForbidden reuses the SHARED catalog copy (no bespoke key)', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.approveResetRequest.mockReturnValueOnce(
      throwError(() => apiError(403, 'Auth.SelfResetForbidden')) as never,
    );
    component.askApprove();
    component.confirmDecision();
    expect(component.errorKey()).toBe('errors.code.Auth.SelfResetForbidden');
  });

  it('an unmapped decision failure (5xx/no code) falls back to the generic inline copy', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.approveResetRequest.mockReturnValueOnce(throwError(() => apiError(500)) as never);
    component.askApprove();
    component.confirmDecision();
    expect(component.errorKey()).toBe('password.resetRequests.error.generic');
  });

  it('refresh() with NO selection reloads the list only (no detail fetch)', () => {
    const { component, api } = setup();
    api.listResetRequests.mockClear();
    api.getResetRequest.mockClear();
    component.refresh();
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
    expect(api.getResetRequest).not.toHaveBeenCalled();
  });

  it('selectRequest and cancelDecision are no-ops while a decision is in flight', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[0]);
    api.approveResetRequest.mockReturnValueOnce(NEVER as never);
    component.askApprove();
    component.confirmDecision();
    expect(component.deciding()).toBe(true);

    api.getResetRequest.mockClear();
    component.selectRequest(SEED[1]); // guarded — the decided row must stay on screen
    expect(api.getResetRequest).not.toHaveBeenCalled();

    component.confirmAction.set('deny');
    component.cancelDecision(); // guarded — the dialog state is owned by the in-flight decision
    expect(component.confirmAction()).toBe('deny');
  });

  it('askApprove with NOTHING selected keeps the dialog closed (canDecide null gate)', () => {
    const { component } = setup();
    expect(component.canDecide()).toBe(false);
    component.askApprove();
    expect(component.confirmAction()).toBeNull();
  });

  it('confirmDecision without a selection makes no call even if a dialog state leaked open', () => {
    const { component, api } = setup();
    component.confirmAction.set('approve'); // selection is null → the guard must bail
    component.confirmDecision();
    expect(api.approveResetRequest).not.toHaveBeenCalled();
    expect(api.denyResetRequest).not.toHaveBeenCalled();
  });

  it('refresh() reloads the list, clears the inline error, and re-pulls the current selection', () => {
    const { component, api } = setup();
    component.selectRequest(SEED[1]);
    component.errorKey.set('password.resetRequests.error.generic');
    api.listResetRequests.mockClear();
    api.getResetRequest.mockClear();
    component.refresh();
    expect(component.errorKey()).toBeNull();
    expect(api.listResetRequests).toHaveBeenCalledTimes(1);
    expect(api.getResetRequest).toHaveBeenCalledWith('req-1'); // detail() stub id
  });

  it('collapses display status: APPROVED + completedAt reads as completed; enum states map 1:1', () => {
    const { component } = setup();
    expect(component.displayStatus(item())).toBe('pending');
    expect(component.displayStatus(item({ status: 'APPROVED' }))).toBe('approved');
    expect(
      component.displayStatus(item({ status: 'APPROVED', completedAt: '2026-07-01T12:00:00Z' })),
    ).toBe('completed');
    expect(component.displayStatus(item({ status: 'DENIED' }))).toBe('denied');
    expect(component.displayStatus(item({ status: 'EXPIRED' }))).toBe('expired');
  });

  it('maps STATIC i18n keys, badge colours and icons per display status (never colour-only)', () => {
    const { component } = setup();
    expect(component.statusKey(item())).toBe('password.resetRequests.status.pending');
    expect(component.statusKey(item({ status: 'EXPIRED' }))).toBe(
      'password.resetRequests.status.expired',
    );
    expect(
      component.statusKey(item({ status: 'APPROVED', completedAt: '2026-07-01T12:00:00Z' })),
    ).toBe('password.resetRequests.status.completed');
    expect(component.statusColor(item())).toBe('yellow');
    expect(component.statusColor(item({ status: 'DENIED' }))).toBe('red');
    expect(component.statusIcon(item())).toBe('ri-time-line');
    expect(component.statusIcon(item({ status: 'APPROVED' }))).toBe('ri-checkbox-circle-line');
  });

  it('requestedTime buckets a recent ISO into the shared relative-time key shape', () => {
    const { component } = setup();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = component.requestedTime(twoHoursAgo);
    expect(result.absolute).toBe(false);
    expect(result.key).toBe('common.time.hoursAgo');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(component.requestedTime(longAgo).absolute).toBe(true);
  });

  it('toggleRawUa flips the collapsible raw user-agent line (and a new selection re-collapses it)', () => {
    const { component } = setup();
    component.selectRequest(SEED[0]);
    expect(component.showRawUa()).toBe(false);
    component.toggleRawUa();
    expect(component.showRawUa()).toBe(true);
    component.selectRequest(SEED[1]); // fresh detail → collapsed again
    expect(component.showRawUa()).toBe(false);
  });

  it('renders the honest template: confirm dialog, out-of-band note, ip honesty note, actions', () => {
    // Structural honesty pins on the raw template (mirrors forgot-password.component.spec's idiom).
    expect(requestsTemplate).toContain('app-ui-confirm-dialog');
    expect(requestsTemplate).toContain('password.resetRequests.intro'); // admin verifies out-of-band
    expect(requestsTemplate).toContain('password.resetRequests.detail.ipNote'); // coarse prefix only
    expect(requestsTemplate).toContain('password.resetRequests.approvedNext'); // user sets own password
    expect(requestsTemplate).toContain('ri-user-shared-line');
    expect(requestsTemplate).toContain('askApprove()');
    expect(requestsTemplate).toContain('askDeny()');
    expect(requestsTemplate).toContain('password.resetRequests.empty');
    // EK-2: every row carries the deep-link scroll anchor the ?request= preselect targets.
    expect(requestsTemplate).toContain('[attr.data-request-id]="item.id"');
  });
});
