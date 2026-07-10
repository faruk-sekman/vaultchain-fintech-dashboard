/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the AuthService opt-in second-factor decision tree.
 * PrismaService + JwtService + ConfigService + the MFA services are mocked; argon2id runs for real so
 * the password check is genuine. Covers: MFA-off → authenticated (session issued, no challenge);
 * MFA-on → mfa_required (challenge created, NO session); trusted-device fast-path skips MFA; and the
 * unchanged generic-401 / no-enumeration behaviour.
 */
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { MfaChallengeService } from '../mfa/mfa-challenge.service';
import type { RememberedDeviceService } from '../mfa/remembered-device.service';
import { AuthService } from './auth.service';

const PASSWORD = 'correct-horse-battery';
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await hash(PASSWORD);
});

function userRecord(over: { mfaEnabled?: boolean; mfaConfirmedAt?: Date | null } = {}) {
  return {
    id: 'u1',
    email: 'op@demo',
    displayName: 'Op',
    passwordHash: PASSWORD_HASH,
    status: 'ACTIVE',
    lockedUntil: null,
    failedLoginCount: 0,
    mfaEnabled: over.mfaEnabled ?? false,
    mfaConfirmedAt: over.mfaConfirmedAt ?? null,
  };
}

function setup(opts: {
  user?: ReturnType<typeof userRecord> | null;
  rememberEnabled?: boolean;
  remembered?: { userId: string } | null;
  mfaRequired?: boolean;
} = {}) {
  const user = opts.user === undefined ? userRecord() : opts.user;
  const prisma = {
    user: {
      findUnique: jest.fn((args: { select?: { userRoles?: unknown } }) =>
        Promise.resolve(args.select?.userRoles ? { userRoles: [] } : user),
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'u1', displayName: 'Op', email: 'op@demo' }),
      update: jest.fn().mockResolvedValue({}),
    },
    loginAttempt: { create: jest.fn().mockResolvedValue({}) },
    refreshToken: { create: jest.fn().mockResolvedValue({}) },
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt') };
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          MFA_REMEMBER_DEVICE_ENABLED: opts.rememberEnabled ?? false,
          MFA_REQUIRED: opts.mfaRequired ?? false,
          MFA_CHALLENGE_TTL: 300,
          MFA_MAX_VERIFY_ATTEMPTS: 5,
        } as Record<string, unknown>)[key],
    ),
  };
  const challenges = { create: jest.fn().mockResolvedValue({ token: 'mfa_c1.secret', challengeId: 'c1', expiresAt: new Date() }) };
  const remembered = { verify: jest.fn().mockResolvedValue(opts.remembered ?? null) };
  // The decision-tree paths exercised here never reach the lockout transition, so NotificationService is
  // never actually used — but ModuleRef is now a constructor dependency, so provide an inert stub.
  const notifications = { emit: jest.fn().mockResolvedValue({ id: 'n1', deduped: false }) };
  const moduleRef = { get: jest.fn().mockReturnValue(notifications) };
  const svc = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    challenges as unknown as MfaChallengeService,
    remembered as unknown as RememberedDeviceService,
    moduleRef as unknown as import('@nestjs/core').ModuleRef,
  );
  return { svc, prisma, challenges, remembered, notifications };
}

describe('AuthService login decision tree (opt-in)', () => {
  it('#1 MFA off (the opt-in default) → authenticated, a session is issued, NO challenge', async () => {
    const { svc, prisma, challenges } = setup({ user: userRecord({ mfaEnabled: false }) });
    const res = await svc.login('op@demo', PASSWORD);
    expect(res.status).toBe('authenticated');
    expect(challenges.create).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).toHaveBeenCalled();
  });

  it('#2 MFA on → mfa_required, a challenge is created, NO session is issued', async () => {
    const { svc, prisma, challenges } = setup({ user: userRecord({ mfaEnabled: true, mfaConfirmedAt: new Date() }) });
    const res = await svc.login('op@demo', PASSWORD);
    expect(res.status).toBe('mfa_required');
    if (res.status === 'mfa_required') expect(res.challengeToken).toBe('mfa_c1.secret');
    expect(challenges.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', purpose: 'LOGIN' }));
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('#3 trusted-device fast-path: remember enabled + a matching token → authenticated, MFA skipped', async () => {
    const { svc, challenges, remembered } = setup({
      user: userRecord({ mfaEnabled: true, mfaConfirmedAt: new Date() }),
      rememberEnabled: true,
      remembered: { userId: 'u1' },
    });
    const res = await svc.login('op@demo', PASSWORD, { rememberDeviceToken: 'rd_x.y' });
    expect(res.status).toBe('authenticated');
    expect(remembered.verify).toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
  });

  it('#4 wrong password and unknown user both → generic 401 (no enumeration)', async () => {
    const a = setup({ user: userRecord() });
    await expect(a.svc.login('op@demo', 'wrong-password')).rejects.toBeInstanceOf(UnauthorizedException);
    const b = setup({ user: null });
    await expect(b.svc.login('ghost@demo', PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('#5 MFA_REQUIRED on + user NOT enrolled → fail closed (403 enrollment-required), NO session (F3)', async () => {
    const { svc, prisma } = setup({ user: userRecord({ mfaEnabled: false }), mfaRequired: true });
    const err = await svc.login('op@demo', PASSWORD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'Auth.MfaEnrollmentRequired' });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled(); // no session issued against policy
  });

  it('#6 MFA_REQUIRED on + user ENROLLED → mfa_required (unchanged), a challenge, NO session', async () => {
    const { svc, prisma, challenges } = setup({
      user: userRecord({ mfaEnabled: true, mfaConfirmedAt: new Date() }),
      mfaRequired: true,
    });
    const res = await svc.login('op@demo', PASSWORD);
    expect(res.status).toBe('mfa_required');
    expect(challenges.create).toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('#7 MFA_REQUIRED off + user not enrolled → authenticated (opt-in default unchanged)', async () => {
    const { svc, prisma } = setup({ user: userRecord({ mfaEnabled: false }), mfaRequired: false });
    const res = await svc.login('op@demo', PASSWORD);
    expect(res.status).toBe('authenticated');
    expect(prisma.refreshToken.create).toHaveBeenCalled();
  });
});
