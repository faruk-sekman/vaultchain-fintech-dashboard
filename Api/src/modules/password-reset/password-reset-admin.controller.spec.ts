/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetAdminController — PasswordResetService mocked. The
 * permission gate itself (PermissionsGuard + @RequirePermissions) is exercised in the guard's own suite;
 * here we assert the thin controller forwards the principal's sub + the DTO fields to the service and
 * returns void (204). otplib/qrcode are mocked so the service chain doesn't load otplib under Jest.
 */
jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { PasswordResetAdminController } from './password-reset-admin.controller';
import type { PasswordResetService } from './password-reset.service';

describe('PasswordResetAdminController', () => {
  it('#1 forwards principal.sub + targetUserId + newPassword to the service and resolves void', async () => {
    const service = { adminReset: jest.fn().mockResolvedValue(undefined) } as unknown as PasswordResetService;
    const ctrl = new PasswordResetAdminController(service);
    const principal: AuthPrincipal = { sub: 'admin-1', permissions: ['auth.password.admin_reset'], permissionVersion: 0 };
    const res = await ctrl.adminReset(principal, { targetUserId: 'target-1', newPassword: 'Aa1!aaaaaaaa' });
    expect(res).toBeUndefined();
    expect(service.adminReset).toHaveBeenCalledWith('admin-1', 'target-1', 'Aa1!aaaaaaaa');
  });
});
