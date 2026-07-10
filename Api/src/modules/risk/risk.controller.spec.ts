/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for RiskController (file-based ≥90% coverage round). RiskService mocked; no DB/HTTP.
 * Covers each route's delegation + the controller's OWN mapping: `record` forwards (id, dto, actor);
 * `screen` unwraps `dto.address` and forwards (id, address); `list` forwards (id, query).
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { RiskController } from './risk.controller';
import type { RiskService } from './risk.service';
import type { CreateRiskDecisionDto, ScreenRiskAddressDto } from './dto/risk.dto';

const actor = { sub: 'op-1', permissions: ['kyc.manage'] } as AuthPrincipal;
const ID = '0190a0b0-0000-7000-8000-000000000000';

function setup() {
  const service = { recordDecision: jest.fn(), screenAddress: jest.fn(), listAssessments: jest.fn() };
  return { service, controller: new RiskController(service as unknown as RiskService) };
}

describe('RiskController', () => {
  it('record forwards the id, dto and actor', async () => {
    const { service, controller } = setup();
    const dto = { decision: 'CLEAR' } as unknown as CreateRiskDecisionDto;
    const result = { data: { id: 'r1' } };
    service.recordDecision.mockResolvedValue(result);
    await expect(controller.record(ID, dto, actor)).resolves.toBe(result);
    expect(service.recordDecision).toHaveBeenCalledWith(ID, dto, actor);
  });

  it('screen unwraps dto.address and forwards (id, address)', async () => {
    const { service, controller } = setup();
    const dto = { address: '0xabc' } as ScreenRiskAddressDto;
    const screening = { data: { risk: 'LOW' } };
    service.screenAddress.mockResolvedValue(screening);
    await expect(controller.screen(ID, dto)).resolves.toBe(screening);
    expect(service.screenAddress).toHaveBeenCalledWith(ID, '0xabc');
  });

  it('list forwards the id and the raw query', async () => {
    const { service, controller } = setup();
    const page = { data: [] };
    service.listAssessments.mockResolvedValue(page);
    const query = { 'page[number]': '1' };
    await expect(controller.list(ID, query)).resolves.toBe(page);
    expect(service.listAssessments).toHaveBeenCalledWith(ID, query);
  });

  it('re-throws when the service rejects', async () => {
    const { service, controller } = setup();
    const boom = new Error('provider down');
    service.screenAddress.mockRejectedValue(boom);
    await expect(controller.screen(ID, { address: '0xabc' } as ScreenRiskAddressDto)).rejects.toBe(boom);
  });
});
