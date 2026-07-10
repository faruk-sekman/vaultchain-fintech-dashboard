/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaLoginService — every collaborator is mocked. Covers: TOTP success
 * (replay floor advanced, challenge consumed, session issued, success audited), TOTP failure (attempt
 * counted, FAIL audited, generic 401, NOT consumed), the remember-device branch (incl. the flag-unset
 * and TTL-default arms), backup-code success / failure, the wrong-purpose (ENROLL) reject, and the lost
 * single-use race.
 */
// otplib/qrcode are ESM-first; mock them so importing the MFA chain (MfaLoginService → TotpService →
// otplib) doesn't load otplib's untransformed source under Jest. TotpService itself is mocked below.
jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { BackupCodeService } from '../mfa/backup-code.service';
import type { MfaChallengeService, OpenChallenge } from '../mfa/mfa-challenge.service';
import type { RememberedDeviceService } from '../mfa/remembered-device.service';
import type { TotpService } from '../mfa/totp.service';
import type { AuthService } from './auth.service';
import { MfaLoginService } from './mfa-login.service';

const LOGIN: OpenChallenge = { id: 'c1', userId: 'u1', purpose: 'LOGIN', attemptCount: 0, maxAttempts: 5 };
const SESSION = {
  refreshToken: 'rt_x.y',
  body: { accessToken: 'jwt', tokenType: 'Bearer', expiresIn: 900, permissions: [], user: { id: 'u1', displayName: 'Op', email: 'o***@e***.com' } },
};

/**
 * `configGet` lets a test pin exactly what `ConfigService.get` returns per key (for the flag/TTL default
 * arms). The default mirrors the shipped defaults: the remember flag follows `rememberEnabled`, TTL = 30d.
 */
function setup(opts: { rememberEnabled?: boolean; configGet?: (key: string) => unknown; emitThrows?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 'u1', totpSecretEnc: 'enc', lastUsedTotpStep: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const totp = { decryptSecret: jest.fn().mockResolvedValue('SECRET'), verify: jest.fn() };
  const backupCodes = { verify: jest.fn() };
  const challenges = { registerFailedAttempt: jest.fn().mockResolvedValue(undefined), consume: jest.fn().mockResolvedValue(true) };
  const remembered = { issue: jest.fn().mockResolvedValue({ token: 'rd_x.y', deviceId: 'd1', expiresAt: new Date() }) };
  const auth = { issueSessionForUser: jest.fn().mockResolvedValue(SESSION) };
  const defaultGet = (key: string) =>
    ({ MFA_REMEMBER_DEVICE_ENABLED: opts.rememberEnabled ?? false, MFA_REMEMBER_DEVICE_TTL: 2_592_000 } as Record<string, unknown>)[key];
  const config = { get: jest.fn(opts.configGet ?? defaultGet) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  // NotificationService is resolved lazily via ModuleRef.get (the Auth↔Notification cycle dodge). `emit`
  // either resolves (default) or rejects (opts.emitThrows) — to prove the new-device notify is BEST-EFFORT.
  const notifications = {
    emit: opts.emitThrows
      ? jest.fn().mockRejectedValue(new Error('notify down'))
      : jest.fn().mockResolvedValue({ id: 'n1', deduped: false }),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(notifications) };
  const svc = new MfaLoginService(
    prisma as unknown as PrismaService,
    totp as unknown as TotpService,
    backupCodes as unknown as BackupCodeService,
    challenges as unknown as MfaChallengeService,
    remembered as unknown as RememberedDeviceService,
    auth as unknown as AuthService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    moduleRef as unknown as import('@nestjs/core').ModuleRef,
  );
  return { svc, prisma, totp, backupCodes, challenges, remembered, auth, audit, notifications, moduleRef };
}

describe('MfaLoginService', () => {
  it('#1 TOTP success: advances the replay floor, consumes the challenge, issues a session, audits SUCCESS', async () => {
    const m = setup();
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 42 });
    const res = await m.svc.verifyTotp(LOGIN, '123456', false, { ip: '1.2.3.4' });
    expect(res.session.refreshToken).toBe('rt_x.y');
    expect(res.rememberDevice).toBeUndefined();
    expect(m.prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', lastUsedTotpStep: null },
      data: { lastUsedTotpStep: 42 },
    });
    expect(m.challenges.consume).toHaveBeenCalledWith('c1', 5);
    expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa.verify', outcome: 'SUCCESS' }));
  });

  it('#2 TOTP failure: counts the attempt, audits FAIL, throws 401, and does NOT consume the challenge', async () => {
    const m = setup();
    m.totp.verify.mockResolvedValue({ ok: false });
    await expect(m.svc.verifyTotp(LOGIN, '000000', false, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith('c1', 5);
    expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAIL' }));
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });

  it('#3 TOTP with no enrolled secret → reject (no decrypt attempted)', async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: 'u1', totpSecretEnc: null, lastUsedTotpStep: null });
    await expect(m.svc.verifyTotp(LOGIN, '123456', false, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.totp.decryptSecret).not.toHaveBeenCalled();
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalled();
  });

  it('#4 remember-device: when asked AND the feature is enabled, a remember token is returned + a new-device SECURITY_ALERT is emitted to the user', async () => {
    const m = setup({ rememberEnabled: true });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 7 });
    const res = await m.svc.verifyTotp(LOGIN, '123456', true, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(m.remembered.issue).toHaveBeenCalled();
    expect(res.rememberDevice).toEqual({ token: 'rd_x.y', ttlSeconds: 2_592_000 });
    // A device was issued → exactly one new-trusted-device notification, to challenge.userId, PII-FREE.
    expect(m.notifications.emit).toHaveBeenCalledTimes(1);
    expect(m.notifications.emit).toHaveBeenCalledWith({
      recipientUserId: 'u1',
      type: 'SECURITY_ALERT',
      severity: 'warning',
      titleKey: 'notifications.security.newTrustedDevice.title',
      bodyKey: 'notifications.security.newTrustedDevice.body',
      params: {},
      resourceType: 'auth.trustedDevice',
    });
  });

  it('#4a new-device notification is best-effort: a thrown emit does NOT fail the login (session still returned, device still issued)', async () => {
    const m = setup({ rememberEnabled: true, emitThrows: true });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 7 });
    // The emit rejects, but the swallow+warn keeps the result intact.
    const res = await m.svc.verifyTotp(LOGIN, '123456', true, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(res.session.refreshToken).toBe('rt_x.y');
    expect(res.rememberDevice).toEqual({ token: 'rd_x.y', ttlSeconds: 2_592_000 });
    expect(m.notifications.emit).toHaveBeenCalledTimes(1); // attempted, threw, was swallowed
  });

  it('#4b remember-device is NOT honored when the feature flag is OFF, even if the user opted in (security gate)', async () => {
    const m = setup(); // MFA_REMEMBER_DEVICE_ENABLED defaults OFF in the config mock
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 8 });
    // The user asks to remember the device (rememberDevice = true), but the master flag is off.
    const res = await m.svc.verifyTotp(LOGIN, '123456', true, { ip: '1.2.3.4', userAgent: 'ua' });
    // No remembered device is minted and no ftd_remember token is returned — "remember" is gated on the flag.
    expect(m.remembered.issue).not.toHaveBeenCalled();
    expect(res.rememberDevice).toBeUndefined();
    // The session is still issued (the second factor was valid); only the remember-device side-effect is suppressed.
    expect(res.session.refreshToken).toBe('rt_x.y');
    // No device issued ⇒ no new-trusted-device notification.
    expect(m.notifications.emit).not.toHaveBeenCalled();
  });

  it('#4c remember-device: the flag is UNSET (config returns undefined) ⇒ `?? false` default ⇒ not honored', async () => {
    // Distinct from #4b (flag explicitly false): here config.get returns undefined, exercising the
    // `(this.config.get(...) ?? false)` default arm. Same outcome — no device minted — but a different branch.
    const m = setup({ configGet: () => undefined });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 11 });
    const res = await m.svc.verifyTotp(LOGIN, '123456', true, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(m.remembered.issue).not.toHaveBeenCalled();
    expect(res.rememberDevice).toBeUndefined();
    expect(m.notifications.emit).not.toHaveBeenCalled(); // no device ⇒ no notification
  });

  it('#4d remember-device: flag ON but MFA_REMEMBER_DEVICE_TTL unset ⇒ falls back to the 30-day default', async () => {
    // Exercises the `?? 2_592_000` TTL default arm: the flag resolves truthy, the TTL key resolves undefined.
    const m = setup({ configGet: (key) => (key === 'MFA_REMEMBER_DEVICE_ENABLED' ? true : undefined) });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 12 });
    const res = await m.svc.verifyTotp(LOGIN, '123456', true, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(m.remembered.issue).toHaveBeenCalledWith('u1', 2_592_000, { ip: '1.2.3.4', userAgent: 'ua' });
    expect(res.rememberDevice).toEqual({ token: 'rd_x.y', ttlSeconds: 2_592_000 }); // default 30d
  });

  it('#5 backup code success issues a session; the recovery path never remembers the device', async () => {
    const m = setup({ rememberEnabled: true });
    m.backupCodes.verify.mockResolvedValue(true);
    const res = await m.svc.verifyBackupCode(LOGIN, 'A1B2C-D3E4F', { ip: '1.2.3.4' });
    expect(res.session.refreshToken).toBe('rt_x.y');
    expect(res.rememberDevice).toBeUndefined();
    expect(m.remembered.issue).not.toHaveBeenCalled();
    // The recovery path never issues a device, so it never emits a new-trusted-device notification.
    expect(m.notifications.emit).not.toHaveBeenCalled();
  });

  it('#6 backup code failure → attempt counted + 401, no consume', async () => {
    const m = setup();
    m.backupCodes.verify.mockResolvedValue(false);
    await expect(m.svc.verifyBackupCode(LOGIN, 'WRONG-CODE0', {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalled();
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });

  it('#7 a non-LOGIN (ENROLL) challenge is rejected before any factor check', async () => {
    const m = setup();
    const enroll: OpenChallenge = { ...LOGIN, purpose: 'ENROLL' };
    await expect(m.svc.verifyTotp(enroll, '123456', false, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.totp.verify).not.toHaveBeenCalled();
  });

  it('#8 lost single-use race: a correct factor but a consumed challenge → 401, no session', async () => {
    const m = setup();
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 9 });
    m.challenges.consume.mockResolvedValue(false); // another request won the race
    await expect(m.svc.verifyTotp(LOGIN, '123456', false, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.auth.issueSessionForUser).not.toHaveBeenCalled();
  });

  it('#9 rejects a TOTP that loses the atomic replay-floor compare-and-set', async () => {
    const m = setup();
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 10 });
    m.prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(m.svc.verifyTotp(LOGIN, '123456', false, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith('c1', 5);
    expect(m.challenges.consume).not.toHaveBeenCalled();
    expect(m.auth.issueSessionForUser).not.toHaveBeenCalled();
  });
});
