/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ApiClientService } from '@core/api/api-client.service';
import { environment } from '../../../environments/environment';

class HttpClientMock {
  get = vi.fn(() => of({}));
  post = vi.fn(() => of({}));
  put = vi.fn(() => of({}));
  patch = vi.fn(() => of({}));
  delete = vi.fn(() => of({}));
}

describe('ApiClientService', () => {
  it('builds url with leading slash and passes params', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.get('/customers', { page: 1, search: 'x' }).subscribe();

    expect(http.get).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/customers`,
      expect.objectContaining({
        params: expect.any(Object),
      }),
    );
    const calls = http.get.mock.calls as any[];
    if (calls.length > 0 && calls[0].length >= 2) {
      const options = calls[0][1];
      expect(options.params.get('page')).toBe('1');
      expect(options.params.get('search')).toBe('x');
    }
  });

  it('accepts path without leading slash', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.get('wallets', {}).subscribe();

    expect(http.get).toHaveBeenCalledWith(`${environment.apiBaseUrl}/wallets`, expect.any(Object));
  });

  it('calls post/put/patch/delete with correct urls', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.post('/items', { a: 1 }).subscribe();
    api.put('/items/1', { a: 2 }).subscribe();
    api.patch('/items/1', { a: 3 }).subscribe();
    api.delete('/items/1').subscribe();

    expect(http.post).toHaveBeenCalledWith(`${environment.apiBaseUrl}/items`, { a: 1 });
    expect(http.put).toHaveBeenCalledWith(`${environment.apiBaseUrl}/items/1`, { a: 2 });
    expect(http.patch).toHaveBeenCalledWith(`${environment.apiBaseUrl}/items/1`, { a: 3 });
    expect(http.delete).toHaveBeenCalledWith(`${environment.apiBaseUrl}/items/1`);
  });

  it('post WITHOUT opts keeps the unchanged 2-arg call (no options object)', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.post('/plain', { a: 1 }).subscribe();
    // The normal post path must call http.post with exactly (url, body) — no 3rd options arg.
    expect(http.post.mock.calls[0].length).toBe(2);
    expect(http.post).toHaveBeenCalledWith(`${environment.apiBaseUrl}/plain`, { a: 1 });
  });

  it('post with withCredentials:true opts into the cookie request', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.post('/auth/refresh', { x: 1 }, { withCredentials: true }).subscribe();
    expect(http.post).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/auth/refresh`,
      { x: 1 },
      { withCredentials: true },
    );
  });

  it('post with custom headers forwards only the headers option (no withCredentials)', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);

    api.post('/transactions', { x: 1 }, { headers: { 'Idempotency-Key': 'abc' } }).subscribe();
    expect(http.post).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/transactions`,
      { x: 1 },
      { headers: { 'Idempotency-Key': 'abc' } },
    );
    // withCredentials must NOT be spread in when not requested (default-off contract).
    expect(http.post.mock.calls[0][2]).not.toHaveProperty('withCredentials');
  });

  it('post with an HttpContext forwards only the context option', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);
    const context = new HttpContext();

    api.post('/ctx', { x: 1 }, { context }).subscribe();
    expect(http.post).toHaveBeenCalledWith(`${environment.apiBaseUrl}/ctx`, { x: 1 }, { context });
  });

  it('post combines withCredentials + headers + context into a single options object', () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);
    const context = new HttpContext();

    api
      .post('/combo', { x: 1 }, { withCredentials: true, headers: { H: '1' }, context })
      .subscribe();
    expect(http.post).toHaveBeenCalledWith(
      `${environment.apiBaseUrl}/combo`,
      { x: 1 },
      {
        withCredentials: true,
        headers: { H: '1' },
        context,
      },
    );
  });

  it('propagates errors for all methods', async () => {
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);
    const err = new Error('fail');
    http.get.mockImplementationOnce(() => throwError(() => err));
    await expect(lastValueFrom(api.get('/x'))).rejects.toBe(err);

    http.post.mockImplementationOnce(() => throwError(() => err));
    await expect(lastValueFrom(api.post('/x', {}))).rejects.toBe(err);

    http.put.mockImplementationOnce(() => throwError(() => err));
    await expect(lastValueFrom(api.put('/x', {}))).rejects.toBe(err);

    http.patch.mockImplementationOnce(() => throwError(() => err));
    await expect(lastValueFrom(api.patch('/x', {}))).rejects.toBe(err);

    http.delete.mockImplementationOnce(() => throwError(() => err));
    await expect(lastValueFrom(api.delete('/x'))).rejects.toBe(err);
  });

  it('does NOT retry a GET on 404 (ops-retry-on-404)', async () => {
    // `defer` re-runs its factory on each (re)subscription, so the counter = number of attempts the
    // retry operator made against the source.
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);
    const notFound = new HttpErrorResponse({ status: 404, statusText: 'Not Found' });
    let attempts = 0;
    http.get.mockReturnValue(
      defer(() => {
        attempts += 1;
        return throwError(() => notFound);
      }),
    );

    await expect(lastValueFrom(api.get('/missing'))).rejects.toBe(notFound);
    // 404 is terminal — exactly one attempt, no retries.
    expect(attempts).toBe(1);
  });

  it('still retries a GET twice on a 5xx (3 attempts) before failing', async () => {
    // Real timers: the two 350ms backoff delays elapse naturally (~700ms total).
    const http = new HttpClientMock();
    const api = new ApiClientService(http as any);
    const serverError = new HttpErrorResponse({ status: 503, statusText: 'Unavailable' });
    let attempts = 0;
    http.get.mockReturnValue(
      defer(() => {
        attempts += 1;
        return throwError(() => serverError);
      }),
    );

    await expect(lastValueFrom(api.get('/flaky'))).rejects.toBe(serverError);
    // 1 initial + 2 retries = 3 attempts (the predicate still backs off on 5xx).
    expect(attempts).toBe(3);
  }, 5000);
});
