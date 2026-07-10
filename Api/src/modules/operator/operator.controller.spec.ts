/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for OperatorController (audit 9C). Thin delegation layer — each route forwards the
 * authenticated actor (and body) to OperatorService unchanged. A later change retired the
 * notification-feed route from this controller (the notification domain owns it now).
 */
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import type { UpdateNotificationPreferencesDto, UpdateOperatorProfileDto } from './dto/operator.dto';
import type { OperatorService } from './operator.service';
import { OperatorController } from './operator.controller';

const actor = { sub: 'op-1' } as AuthPrincipal;

function make() {
  const service = {
    getProfile: jest.fn(),
    updateProfile: jest.fn(),
    getNotificationPreferences: jest.fn(),
    updateNotificationPreferences: jest.fn(),
  };
  const controller = new OperatorController(service as unknown as OperatorService);
  return { service, controller };
}

describe('OperatorController', () => {
  it('getProfile delegates to the service with the actor', async () => {
    const { service, controller } = make();
    const profile = { displayName: 'A', email: 'a@x.io', phone: null, jobTitle: null };
    service.getProfile.mockResolvedValue(profile);
    await expect(controller.getProfile(actor)).resolves.toBe(profile);
    expect(service.getProfile).toHaveBeenCalledWith(actor);
  });

  it('updateProfile forwards the actor and dto', async () => {
    const { service, controller } = make();
    const dto = { displayName: 'New' } as UpdateOperatorProfileDto;
    service.updateProfile.mockResolvedValue('ok');
    await controller.updateProfile(actor, dto);
    expect(service.updateProfile).toHaveBeenCalledWith(actor, dto);
  });

  it('getNotificationPreferences delegates with the actor', async () => {
    const { service, controller } = make();
    service.getNotificationPreferences.mockResolvedValue('prefs');
    await controller.getNotificationPreferences(actor);
    expect(service.getNotificationPreferences).toHaveBeenCalledWith(actor);
  });

  it('updateNotificationPreferences forwards the actor and dto', async () => {
    const { service, controller } = make();
    const dto = { weeklyDigest: true } as UpdateNotificationPreferencesDto;
    service.updateNotificationPreferences.mockResolvedValue('prefs');
    await controller.updateNotificationPreferences(actor, dto);
    expect(service.updateNotificationPreferences).toHaveBeenCalledWith(actor, dto);
  });
});
