/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for AnalyticsController (file-based ≥90% coverage round). AnalyticsService is mocked;
 * no DB/HTTP. Covers each route's delegation + the controller's OWN branches: recent-customers
 * limit-parsing (`limit === undefined ? 3 : Number(limit)`) and latest-customer's `?? null`
 * empty-coalescing.
 */
import { AnalyticsController } from './analytics.controller';
import type { AnalyticsService } from './analytics.service';

function setup() {
  const service = {
    getSummary: jest.fn(),
    getKycDistribution: jest.fn(),
    getLatestCustomer: jest.fn(),
    getRecentCustomers: jest.fn(),
  };
  return { service, controller: new AnalyticsController(service as unknown as AnalyticsService) };
}

describe('AnalyticsController', () => {
  it('getSummary delegates and returns the service value', async () => {
    const { service, controller } = setup();
    const summary = { totalCustomers: 5 };
    service.getSummary.mockResolvedValue(summary);
    await expect(controller.getSummary()).resolves.toBe(summary);
    expect(service.getSummary).toHaveBeenCalledWith();
  });

  it('getKycDistribution delegates and returns the service value', async () => {
    const { service, controller } = setup();
    const dist = { VERIFIED: 3 };
    service.getKycDistribution.mockResolvedValue(dist);
    await expect(controller.getKycDistribution()).resolves.toBe(dist);
    expect(service.getKycDistribution).toHaveBeenCalledWith();
  });

  it('getLatestCustomer returns the customer when one exists', async () => {
    const { service, controller } = setup();
    const latest = { data: { id: 'c1' } };
    service.getLatestCustomer.mockResolvedValue(latest);
    await expect(controller.getLatestCustomer()).resolves.toBe(latest);
  });

  it('getLatestCustomer coalesces an undefined service result to null', async () => {
    const { service, controller } = setup();
    service.getLatestCustomer.mockResolvedValue(undefined);
    await expect(controller.getLatestCustomer()).resolves.toBeNull();
  });

  it('getLatestCustomer passes through an explicit null result as null', async () => {
    const { service, controller } = setup();
    service.getLatestCustomer.mockResolvedValue(null);
    await expect(controller.getLatestCustomer()).resolves.toBeNull();
  });

  it('getRecentCustomers defaults the limit to 3 when the query param is absent', async () => {
    const { service, controller } = setup();
    const rows = [{ id: 'c1' }];
    service.getRecentCustomers.mockResolvedValue(rows);
    await expect(controller.getRecentCustomers(undefined)).resolves.toBe(rows);
    expect(service.getRecentCustomers).toHaveBeenCalledWith(3);
  });

  it('getRecentCustomers parses a provided numeric limit string', async () => {
    const { service, controller } = setup();
    service.getRecentCustomers.mockResolvedValue([]);
    await controller.getRecentCustomers('7');
    expect(service.getRecentCustomers).toHaveBeenCalledWith(7);
  });

  it('getRecentCustomers forwards NaN for a non-numeric limit (service owns the guard)', async () => {
    const { service, controller } = setup();
    service.getRecentCustomers.mockResolvedValue([]);
    await controller.getRecentCustomers('abc');
    expect(service.getRecentCustomers).toHaveBeenCalledWith(NaN);
  });

  it('re-throws when the service rejects', async () => {
    const { service, controller } = setup();
    const boom = new Error('db down');
    service.getSummary.mockRejectedValue(boom);
    await expect(controller.getSummary()).rejects.toBe(boom);
  });
});
