/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for NotificationController (file-based ≥90% coverage round). NotificationService mocked;
 * no DB/HTTP. Thin delegation layer — each route forwards the authenticated actor (recipient scope is
 * enforced in the service) + the query/id, and passes the return value through.
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { NotificationController } from './notification.controller';
import type { NotificationService } from './notification.service';

const actor = { sub: 'user-A', permissions: [], permissionVersion: 0 } as AuthPrincipal;
const NOTIF_ID = '0190a0b0-0000-7000-8000-000000000010';

function setup() {
  const service = {
    list: jest.fn(),
    markRead: jest.fn(),
    markAll: jest.fn(),
  };
  return { service, controller: new NotificationController(service as unknown as NotificationService) };
}

describe('NotificationController', () => {
  it('list forwards the actor + raw query', async () => {
    const { service, controller } = setup();
    const query = { 'filter[read]': 'false' };
    const paged = { data: [], page: { number: 1, size: 20, totalItems: 0, totalPages: 1 }, unreadCount: 0 };
    service.list.mockResolvedValue(paged);
    await expect(controller.list(actor, query)).resolves.toBe(paged);
    expect(service.list).toHaveBeenCalledWith(actor, query);
  });

  it('markRead forwards the actor + id', async () => {
    const { service, controller } = setup();
    service.markRead.mockResolvedValue({ unreadCount: 2 });
    await expect(controller.markRead(actor, NOTIF_ID)).resolves.toEqual({ unreadCount: 2 });
    expect(service.markRead).toHaveBeenCalledWith(actor, NOTIF_ID);
  });

  it('markAll forwards the actor', async () => {
    const { service, controller } = setup();
    service.markAll.mockResolvedValue({ unreadCount: 0 });
    await expect(controller.markAll(actor)).resolves.toEqual({ unreadCount: 0 });
    expect(service.markAll).toHaveBeenCalledWith(actor);
  });

  it('re-throws when the service rejects (e.g. 404 on a non-owned id)', async () => {
    const { service, controller } = setup();
    const boom = new Error('not found');
    service.markRead.mockRejectedValue(boom);
    await expect(controller.markRead(actor, NOTIF_ID)).rejects.toBe(boom);
  });
});
