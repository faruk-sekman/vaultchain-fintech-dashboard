/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for CustomersController (file-based ≥90% coverage round). CustomersService mocked;
 * no DB/HTTP. Covers each route's delegation + the controller's OWN logic: the `?reveal` query
 * branch on getById (via parseReveal — only the literal `'true'` requests an unmask; the SERVICE
 * still gates the effective reveal on `customers.pii.reveal`), and actor/dto/id forwarding.
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { CustomersController } from './customers.controller';
import type { CustomersService } from './customers.service';
import type { CreateCustomerDto, UpdateCustomerDto } from './dto/customer-write.dto';

const actor = { sub: 'op-1', permissions: ['customers.read'] } as AuthPrincipal;
const ID = '0190a0b0-0000-7000-8000-000000000000';

function setup() {
  const service = {
    list: jest.fn(),
    getById: jest.fn(),
    listKycVerifications: jest.fn(),
    getCredentialPreview: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
  };
  return { service, controller: new CustomersController(service as unknown as CustomersService) };
}

describe('CustomersController', () => {
  it('list forwards the raw query and the actor', async () => {
    const { service, controller } = setup();
    const page = { data: [], page: { number: 1 } };
    service.list.mockResolvedValue(page);
    const query = { 'page[number]': '1', reveal: 'true' };
    await expect(controller.list(query, actor)).resolves.toBe(page);
    expect(service.list).toHaveBeenCalledWith(query, actor);
  });

  it('getById requests an unmask only for the literal reveal="true"', async () => {
    const { service, controller } = setup();
    const detail = { data: { id: ID } };
    service.getById.mockResolvedValue(detail);
    await expect(controller.getById(ID, 'true', actor)).resolves.toBe(detail);
    expect(service.getById).toHaveBeenCalledWith(ID, { reveal: true, principal: actor });
  });

  it('getById keeps reveal=false for an absent reveal query param', async () => {
    const { service, controller } = setup();
    service.getById.mockResolvedValue({ data: { id: ID } });
    await controller.getById(ID, undefined, actor);
    expect(service.getById).toHaveBeenCalledWith(ID, { reveal: false, principal: actor });
  });

  it('getById keeps reveal=false for a non-literal reveal value (e.g. "1"/"TRUE")', async () => {
    const { service, controller } = setup();
    service.getById.mockResolvedValue({ data: { id: ID } });
    await controller.getById(ID, '1', actor);
    expect(service.getById).toHaveBeenCalledWith(ID, { reveal: false, principal: actor });
    await controller.getById(ID, 'TRUE', actor);
    expect(service.getById).toHaveBeenLastCalledWith(ID, { reveal: false, principal: actor });
  });

  it('listKycVerifications forwards the id and the raw query', async () => {
    const { service, controller } = setup();
    const list = { data: [] };
    service.listKycVerifications.mockResolvedValue(list);
    const query = { 'page[size]': '10' };
    await expect(controller.listKycVerifications(ID, query)).resolves.toBe(list);
    expect(service.listKycVerifications).toHaveBeenCalledWith(ID, query);
  });

  it('getCredentialPreview delegates with the id', async () => {
    const { service, controller } = setup();
    const preview = { data: { firstNameInitial: 'A' } };
    service.getCredentialPreview.mockResolvedValue(preview);
    await expect(controller.getCredentialPreview(ID)).resolves.toBe(preview);
    expect(service.getCredentialPreview).toHaveBeenCalledWith(ID);
  });

  it('create forwards the dto and the actor', async () => {
    const { service, controller } = setup();
    const dto = { fullName: 'Jane' } as CreateCustomerDto;
    const created = { data: { id: ID } };
    service.create.mockResolvedValue(created);
    await expect(controller.create(dto, actor)).resolves.toBe(created);
    expect(service.create).toHaveBeenCalledWith(dto, actor);
  });

  it('update forwards the id, dto and actor', async () => {
    const { service, controller } = setup();
    const dto = { fullName: 'Jane R.' } as UpdateCustomerDto;
    const updated = { data: { id: ID } };
    service.update.mockResolvedValue(updated);
    await expect(controller.update(ID, dto, actor)).resolves.toBe(updated);
    expect(service.update).toHaveBeenCalledWith(ID, dto, actor);
  });

  it('remove delegates the soft-delete with the id and actor', async () => {
    const { service, controller } = setup();
    service.softDelete.mockResolvedValue(undefined);
    await expect(controller.remove(ID, actor)).resolves.toBeUndefined();
    expect(service.softDelete).toHaveBeenCalledWith(ID, actor);
  });

  it('re-throws when the service rejects', async () => {
    const { service, controller } = setup();
    const boom = new Error('not found');
    service.getById.mockRejectedValue(boom);
    await expect(controller.getById(ID, undefined, actor)).rejects.toBe(boom);
  });
});
