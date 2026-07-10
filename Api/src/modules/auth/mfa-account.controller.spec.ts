/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaAccountController (file-based ≥90% coverage round). MfaEnrollmentService +
 * MfaManagementService mocked; no DB/HTTP. Thin self-service layer — each route threads
 * principal.sub (and the relevant dto field / path param) to the right service method. admin-reset
 * forwards the ACTOR's sub plus the target dto.userId.
 *
 * otplib/qrcode are ESM-first; mock them so importing the enrollment/management service chain
 * (-> TotpService) doesn't pull otplib in under Jest.
 */
jest.mock('otplib', () => ({ authenticator: {}, generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { MfaAccountController } from './mfa-account.controller';
import type { MfaEnrollmentService } from './mfa-enrollment.service';
import type { MfaManagementService } from './mfa-management.service';
import type {
  AdminResetMfaDto,
  ConfirmMfaSetupDto,
  MfaReauthDto,
  StartMfaSetupDto,
} from '../mfa/dto/mfa.dto';

const principal = { sub: 'op-1', permissions: [], permissionVersion: 0 } as AuthPrincipal;

function setup() {
  const enrollment = { start: jest.fn(), confirm: jest.fn() };
  const management = {
    disable: jest.fn(),
    regenerateBackupCodes: jest.fn(),
    adminReset: jest.fn(),
    listDevices: jest.fn(),
    revokeDevice: jest.fn(),
  };
  const controller = new MfaAccountController(
    enrollment as unknown as MfaEnrollmentService,
    management as unknown as MfaManagementService,
  );
  return { enrollment, management, controller };
}

describe('MfaAccountController', () => {
  it('setupStart forwards (principal.sub, dto.password)', async () => {
    const { enrollment, controller } = setup();
    const dto = { password: 'pw' } as StartMfaSetupDto;
    const out = { otpauthUri: 'otpauth://x', qrDataUrl: 'data:' };
    enrollment.start.mockResolvedValue(out);
    await expect(controller.setupStart(principal, dto)).resolves.toBe(out);
    expect(enrollment.start).toHaveBeenCalledWith('op-1', 'pw');
  });

  it('setupConfirm forwards (principal.sub, dto.code)', async () => {
    const { enrollment, controller } = setup();
    const dto = { code: '123456' } as ConfirmMfaSetupDto;
    const out = { backupCodes: ['a', 'b'] };
    enrollment.confirm.mockResolvedValue(out);
    await expect(controller.setupConfirm(principal, dto)).resolves.toBe(out);
    expect(enrollment.confirm).toHaveBeenCalledWith('op-1', '123456');
  });

  it('disable forwards (principal.sub, dto.password, dto.code)', async () => {
    const { management, controller } = setup();
    const dto = { password: 'pw', code: '123456' } as MfaReauthDto;
    management.disable.mockResolvedValue(undefined);
    await expect(controller.disable(principal, dto)).resolves.toBeUndefined();
    expect(management.disable).toHaveBeenCalledWith('op-1', 'pw', '123456');
  });

  it('regenerateBackupCodes forwards (principal.sub, dto.password, dto.code)', async () => {
    const { management, controller } = setup();
    const dto = { password: 'pw', code: '654321' } as MfaReauthDto;
    const out = { backupCodes: ['c', 'd'] };
    management.regenerateBackupCodes.mockResolvedValue(out);
    await expect(controller.regenerateBackupCodes(principal, dto)).resolves.toBe(out);
    expect(management.regenerateBackupCodes).toHaveBeenCalledWith('op-1', 'pw', '654321');
  });

  it('adminReset forwards (actor.sub, dto.userId) — the actor resets a TARGET user', async () => {
    const { management, controller } = setup();
    const admin = { sub: 'admin-1', permissions: ['auth.mfa.admin_reset'] } as AuthPrincipal;
    const dto = { userId: 'target-9' } as AdminResetMfaDto;
    management.adminReset.mockResolvedValue(undefined);
    await expect(controller.adminReset(admin, dto)).resolves.toBeUndefined();
    expect(management.adminReset).toHaveBeenCalledWith('admin-1', 'target-9');
  });

  it('listDevices forwards principal.sub', async () => {
    const { management, controller } = setup();
    const devices = [{ id: 'd1' }];
    management.listDevices.mockResolvedValue(devices);
    await expect(controller.listDevices(principal)).resolves.toBe(devices);
    expect(management.listDevices).toHaveBeenCalledWith('op-1');
  });

  it('revokeDevice forwards (principal.sub, id)', async () => {
    const { management, controller } = setup();
    management.revokeDevice.mockResolvedValue(undefined);
    await expect(controller.revokeDevice(principal, 'dev-7')).resolves.toBeUndefined();
    expect(management.revokeDevice).toHaveBeenCalledWith('op-1', 'dev-7');
  });

  it('re-throws when a service rejects (e.g. wrong password on disable)', async () => {
    const { management, controller } = setup();
    const boom = new Error('reauth failed');
    management.disable.mockRejectedValue(boom);
    await expect(controller.disable(principal, { password: 'bad', code: '000000' } as MfaReauthDto)).rejects.toBe(boom);
  });
});
