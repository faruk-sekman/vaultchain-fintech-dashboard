/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetRequestAdminController (A15) — PasswordResetRequestService mocked.
 * Covers: the thin delegations (list with the parsed ?status= filter, detail, approve/deny with the
 * caller as decider), the stable-400 rejection of an invalid status filter, and the route metadata
 * contract — every route requires `auth.password.admin_reset` (PermissionsGuard input), approve/deny
 * answer 200 and carry the 10/min @Throttle, and service errors pass through untouched (the stable
 * Auth.ResetRequest* envelopes are produced by the service, asserted in its own spec).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { PERMISSIONS_KEY } from '../../common/auth/require-permissions.decorator';
import { PasswordResetRequestAdminController } from './password-reset-request-admin.controller';
import type { PasswordResetRequestService } from './password-reset-request.service';

const ADMIN = { sub: 'admin-1', permissions: ['auth.password.admin_reset'] } as AuthPrincipal;
const REQ_ID = '0190a0b0-0000-7000-8000-0000000000bb';

function makeService(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    detail: jest.fn().mockResolvedValue({ id: REQ_ID }),
    decide: jest.fn().mockResolvedValue({ id: REQ_ID, status: 'APPROVED' }),
    ...overrides,
  } as unknown as PasswordResetRequestService & Record<string, jest.Mock>;
}

describe('PasswordResetRequestAdminController', () => {
  it('#1 list: no filter → undefined; a valid ?status= is parsed to the enum value', async () => {
    const service = makeService();
    const ctrl = new PasswordResetRequestAdminController(service);
    await ctrl.list(undefined);
    expect(service.list).toHaveBeenCalledWith(undefined);
    await ctrl.list('PENDING');
    expect(service.list).toHaveBeenCalledWith('PENDING');
    await ctrl.list('  DENIED  '); // trimmed
    expect(service.list).toHaveBeenCalledWith('DENIED');
  });

  it('#2 list: an unknown ?status= value is a stable 400 Validation.Failed (never a 500)', () => {
    const ctrl = new PasswordResetRequestAdminController(makeService());
    // parseStatusFilter fires synchronously (before any service call) — assert the sync throw.
    expect(() => ctrl.list('BOGUS')).toThrow(BadRequestException);
    try {
      ctrl.list('BOGUS');
      fail('expected a BadRequestException');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'Validation.Failed' });
    }
  });

  it('#3 detail delegates the id', async () => {
    const service = makeService();
    const ctrl = new PasswordResetRequestAdminController(service);
    await ctrl.detail(REQ_ID);
    expect(service.detail).toHaveBeenCalledWith(REQ_ID);
  });

  it('#4 approve/deny delegate with the CALLER as decider and the matching decision', async () => {
    const service = makeService();
    const ctrl = new PasswordResetRequestAdminController(service);
    await ctrl.approve(ADMIN, REQ_ID);
    expect(service.decide).toHaveBeenCalledWith('admin-1', REQ_ID, 'APPROVED');
    await ctrl.deny(ADMIN, REQ_ID);
    expect(service.decide).toHaveBeenCalledWith('admin-1', REQ_ID, 'DENIED');
  });

  it('#5 service errors (e.g. 409 AlreadyDecided) pass through untouched — the controller adds nothing', async () => {
    const service = makeService({
      decide: jest.fn().mockRejectedValue(
        new ConflictException({ code: 'Auth.ResetRequestAlreadyDecided', message: 'decided' }),
      ),
    });
    const ctrl = new PasswordResetRequestAdminController(service);
    await expect(ctrl.approve(ADMIN, REQ_ID)).rejects.toMatchObject({
      response: { code: 'Auth.ResetRequestAlreadyDecided' },
    });
  });

  it('#6 EVERY route requires auth.password.admin_reset (deny-by-default permission gate)', () => {
    const proto = PasswordResetRequestAdminController.prototype;
    for (const handler of [proto.list, proto.detail, proto.approve, proto.deny]) {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['auth.password.admin_reset']);
    }
  });

  it('#7 approve/deny answer 200 and carry the 10/min @Throttle; the controller path is the plural queue', () => {
    const proto = PasswordResetRequestAdminController.prototype;
    expect(Reflect.getMetadata('path', PasswordResetRequestAdminController)).toBe('auth/password/reset-requests');
    for (const handler of [proto.approve, proto.deny]) {
      expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    }
  });
});
