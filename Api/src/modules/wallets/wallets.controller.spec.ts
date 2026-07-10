/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for WalletsController (file-based ≥90% coverage round). WalletsService mocked; thin
 * delegation — assert id/dto/actor forwarding and return-value pass-through for both routes.
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { WalletsController } from './wallets.controller';
import type { WalletsService } from './wallets.service';
import type { UpdateWalletLimitsDto } from './dto/update-wallet-limits.dto';

const actor = { sub: 'op-1', permissions: ['wallets.manage-limits'] } as AuthPrincipal;
const ID = '0190a0b0-0000-7000-8000-000000000000';

function setup() {
  const service = { getForCustomer: jest.fn(), updateLimits: jest.fn() };
  return { service, controller: new WalletsController(service as unknown as WalletsService) };
}

describe('WalletsController', () => {
  it('getForCustomer delegates with the id and returns the value', async () => {
    const { service, controller } = setup();
    const wallet = { data: { id: 'w1' } };
    service.getForCustomer.mockResolvedValue(wallet);
    await expect(controller.getForCustomer(ID)).resolves.toBe(wallet);
    expect(service.getForCustomer).toHaveBeenCalledWith(ID);
  });

  it('updateLimits forwards the id, dto and actor', async () => {
    const { service, controller } = setup();
    const dto = { dailyLimitMinor: 100, rowVersion: 1 } as unknown as UpdateWalletLimitsDto;
    const updated = { data: { id: 'w1' } };
    service.updateLimits.mockResolvedValue(updated);
    await expect(controller.updateLimits(ID, dto, actor)).resolves.toBe(updated);
    expect(service.updateLimits).toHaveBeenCalledWith(ID, dto, actor);
  });

  it('re-throws when the service rejects', async () => {
    const { service, controller } = setup();
    const boom = new Error('wallet missing');
    service.getForCustomer.mockRejectedValue(boom);
    await expect(controller.getForCustomer(ID)).rejects.toBe(boom);
  });
});
