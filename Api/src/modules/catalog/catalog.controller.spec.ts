/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for CatalogController (file-based ≥90% coverage round). CatalogService mocked; thin
 * delegation layer with a single route — assert it forwards with no args and returns the value.
 */
import { CatalogController } from './catalog.controller';
import type { CatalogService } from './catalog.service';

function setup() {
  const service = { listActiveCurrencies: jest.fn() };
  return { service, controller: new CatalogController(service as unknown as CatalogService) };
}

describe('CatalogController', () => {
  it('listCurrencies delegates to listActiveCurrencies and returns its value', async () => {
    const { service, controller } = setup();
    const catalog = { data: [{ code: 'TRY' }] };
    service.listActiveCurrencies.mockResolvedValue(catalog);
    await expect(controller.listCurrencies()).resolves.toBe(catalog);
    expect(service.listActiveCurrencies).toHaveBeenCalledWith();
  });

  it('re-throws when the service rejects', async () => {
    const { service, controller } = setup();
    const boom = new Error('catalog unavailable');
    service.listActiveCurrencies.mockRejectedValue(boom);
    await expect(controller.listCurrencies()).rejects.toBe(boom);
  });
});
