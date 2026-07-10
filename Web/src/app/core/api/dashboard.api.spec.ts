/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for DashboardApi (audit 9C Web). Mocks ApiClientService; proves each method hits the
 * right path and unwraps the `{ data }` envelope (incl. the null latest-customer + the recent limit).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, firstValueFrom } from 'rxjs';
import { ApiClientService } from '@core/api/api-client.service';
import { DashboardApi } from './dashboard.api';

describe('DashboardApi', () => {
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  let service: DashboardApi;

  beforeEach(() => {
    api = { get: vi.fn(), post: vi.fn() };
    TestBed.configureTestingModule({
      providers: [DashboardApi, { provide: ApiClientService, useValue: api }],
    });
    service = TestBed.inject(DashboardApi);
  });

  it('getSummary unwraps the envelope', async () => {
    const summary = { totalCustomers: 5 };
    api.get.mockReturnValue(of({ data: summary }));
    await expect(firstValueFrom(service.getSummary())).resolves.toBe(summary);
    expect(api.get).toHaveBeenCalledWith('/dashboard/summary');
  });

  it('getKycDistribution unwraps the envelope', async () => {
    const kyc = { items: [], total: 0, asOf: 'x' };
    api.get.mockReturnValue(of({ data: kyc }));
    await expect(firstValueFrom(service.getKycDistribution())).resolves.toBe(kyc);
    expect(api.get).toHaveBeenCalledWith('/dashboard/kyc-distribution');
  });

  it('getLatestCustomer passes through a null body', async () => {
    api.get.mockReturnValue(of({ data: null }));
    await expect(firstValueFrom(service.getLatestCustomer())).resolves.toBeNull();
    expect(api.get).toHaveBeenCalledWith('/dashboard/latest-customer');
  });

  it('getRecentCustomers forwards an explicit limit', async () => {
    api.get.mockReturnValue(of({ data: [] }));
    await firstValueFrom(service.getRecentCustomers(7));
    expect(api.get).toHaveBeenCalledWith('/dashboard/recent-customers', { limit: 7 });
  });

  it('getRecentCustomers defaults the limit to 3', async () => {
    api.get.mockReturnValue(of({ data: [] }));
    await firstValueFrom(service.getRecentCustomers());
    expect(api.get).toHaveBeenCalledWith('/dashboard/recent-customers', { limit: 3 });
  });

  it('authorizeStream posts with credentials and resolves void', async () => {
    api.post.mockReturnValue(of(undefined));
    await expect(firstValueFrom(service.authorizeStream())).resolves.toBeUndefined();
    expect(api.post).toHaveBeenCalledWith('/dashboard/stream-token', {}, { withCredentials: true });
  });
});
