/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for CustomerTransactionsController (file-based ≥90% coverage round).
 * CustomerTransactionsService mocked; thin delegation — assert id/query forwarding to
 * listForCustomer and return-value pass-through.
 */
import { CustomerTransactionsController } from './customer-transactions.controller';
import type { CustomerTransactionsService } from './customer-transactions.service';

const ID = '0190a0b0-0000-7000-8000-000000000000';

function setup() {
  const service = { listForCustomer: jest.fn() };
  return { service, controller: new CustomerTransactionsController(service as unknown as CustomerTransactionsService) };
}

describe('CustomerTransactionsController', () => {
  it('list forwards the customer id and the raw query', async () => {
    const { service, controller } = setup();
    const page = { data: [], page: { number: 1 } };
    service.listForCustomer.mockResolvedValue(page);
    const query = { 'filter[occurredFrom]': '2026-01-01', 'filter[occurredTo]': '2026-02-01' };
    await expect(controller.list(ID, query)).resolves.toBe(page);
    expect(service.listForCustomer).toHaveBeenCalledWith(ID, query);
  });

  it('re-throws when the service rejects (e.g. unbounded date range)', async () => {
    const { service, controller } = setup();
    const boom = new Error('range required');
    service.listForCustomer.mockRejectedValue(boom);
    await expect(controller.list(ID, {})).rejects.toBe(boom);
  });
});
