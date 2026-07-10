/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetChallengeService (markFactorVerified added)
 * — PrismaService is mocked; argon2id runs for real so the hash-only-storage + verify
 * path is exercised end-to-end. Covers: opaque-token shape, hash-not-plaintext storage, fingerprint
 * passthrough, the new factor_verified_at/factor_method passthrough, fail-closed reject paths
 * (malformed/unknown/expired/consumed/exhausted/wrong-secret), atomic single-use consume (and the
 * tx-client variant), the per-challenge attempt counter, and the atomic SET-ONCE markFactorVerified.
 */
import { PasswordResetChallengeService } from './password-reset-challenge.service';
import { PasswordResetPurpose } from './password-reset.constants';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

interface ChallengeRow {
  id: string;
  tokenHash: string;
  userId: string;
  purpose: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  createdIpHash: string | null;
  uaHash: string | null;
  factorVerifiedAt: Date | null;
  factorMethod: string | null;
  createdAt: Date;
}

function makePrisma(): {
  passwordResetChallenge: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
} {
  return {
    passwordResetChallenge: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  };
}

async function mint(
  prisma: ReturnType<typeof makePrisma>,
  overrides: Partial<Pick<ChallengeRow, 'maxAttempts'>> & { ip?: string; userAgent?: string } = {},
): Promise<{ svc: PasswordResetChallengeService; token: string; challengeId: string; stored: Record<string, unknown> }> {
  let stored: Record<string, unknown> = {};
  prisma.passwordResetChallenge.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    stored = args.data;
    return Promise.resolve(args.data);
  });
  const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
  const issued = await svc.create({
    userId: 'u1',
    purpose: PasswordResetPurpose.PasswordReset,
    ttlSeconds: 300,
    maxAttempts: overrides.maxAttempts ?? 5,
    ip: overrides.ip,
    userAgent: overrides.userAgent,
  });
  return { svc, token: issued.token, challengeId: issued.challengeId, stored };
}

function rowFor(challengeId: string, stored: Record<string, unknown>, over: Partial<ChallengeRow> = {}): ChallengeRow {
  return {
    id: challengeId,
    tokenHash: String(stored.tokenHash),
    userId: 'u1',
    purpose: String(stored.purpose),
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    attemptCount: 0,
    maxAttempts: Number(stored.maxAttempts),
    createdIpHash: (stored.createdIpHash as string | null) ?? null,
    uaHash: (stored.uaHash as string | null) ?? null,
    factorVerifiedAt: null,
    factorMethod: null,
    createdAt: new Date(),
    ...over,
  };
}

describe('PasswordResetChallengeService', () => {
  it('#1 create returns pwr_<id>.<secret> and persists ONLY the argon2id hash (never the secret)', async () => {
    const prisma = makePrisma();
    const { token, challengeId, stored } = await mint(prisma);
    expect(token.startsWith('pwr_')).toBe(true);
    expect(token.startsWith(`pwr_${challengeId}.`)).toBe(true);
    const secret = token.slice(`pwr_${challengeId}.`.length);
    expect(secret.length).toBeGreaterThan(20);
    expect(String(stored.tokenHash)).toMatch(/^\$argon2/);
    expect(String(stored.tokenHash)).not.toContain(secret);
    expect(stored.purpose).toBe('PASSWORD_RESET');
    expect(stored.maxAttempts).toBe(5);
  });

  it('#2 create stores sha256 fingerprints (not raw ip/ua) and loadOpen returns them', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma, { ip: '1.2.3.4', userAgent: 'ua-x' });
    expect(stored.createdIpHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.uaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.createdIpHash).not.toBe('1.2.3.4');
    prisma.passwordResetChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored));
    const open = await svc.loadOpen(token);
    expect(open?.createdIpHash).toBe(stored.createdIpHash);
    expect(open?.uaHash).toBe(stored.uaHash);
  });

  it('#3 loadOpen verifies a valid token and returns the open challenge (incl. factor fields, null when unstamped)', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);
    prisma.passwordResetChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored));
    const open = await svc.loadOpen(token);
    expect(open).not.toBeNull();
    expect(open?.userId).toBe('u1');
    expect(open?.purpose).toBe('PASSWORD_RESET');
    expect(open?.factorVerifiedAt).toBeNull();
    expect(open?.factorMethod).toBeNull();
  });

  it('#3b loadOpen surfaces a stamped factor (factorVerifiedAt + factorMethod) from the row', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);
    const stampedAt = new Date();
    prisma.passwordResetChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored, { factorVerifiedAt: stampedAt, factorMethod: 'totp' }));
    const open = await svc.loadOpen(token);
    expect(open?.factorVerifiedAt).toEqual(stampedAt);
    expect(open?.factorMethod).toBe('totp');
  });

  it('#4 loadOpen returns null for a malformed or non-UUID token (no DB hit)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    expect(await svc.loadOpen('nope')).toBeNull();
    expect(await svc.loadOpen('pwr_not-a-uuid.secret')).toBeNull();
    expect(await svc.loadOpen('pwr_.')).toBeNull();
    expect(await svc.loadOpen('mfa_x.y')).toBeNull(); // wrong prefix
    expect(prisma.passwordResetChallenge.findUnique).not.toHaveBeenCalled();
  });

  it('#5 loadOpen returns null for unknown / expired / consumed / attempt-exhausted (fail-closed)', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);

    prisma.passwordResetChallenge.findUnique.mockResolvedValueOnce(null);
    expect(await svc.loadOpen(token)).toBeNull();

    prisma.passwordResetChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { expiresAt: new Date(Date.now() - 1) }));
    expect(await svc.loadOpen(token)).toBeNull();

    prisma.passwordResetChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { consumedAt: new Date() }));
    expect(await svc.loadOpen(token)).toBeNull();

    prisma.passwordResetChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { attemptCount: 5, maxAttempts: 5 }));
    expect(await svc.loadOpen(token)).toBeNull();
  });

  it('#6 loadOpen returns null when the secret does not match the stored hash', async () => {
    const prisma = makePrisma();
    const { challengeId, stored } = await mint(prisma);
    prisma.passwordResetChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored));
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    const forged = `pwr_${challengeId}.${'A'.repeat(43)}`;
    expect(await svc.loadOpen(forged)).toBeNull();
  });

  it('#6b loadOpen swallows an argon2 reject on a corrupt stored hash and returns null (the `.catch(() => false)` arm)', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);
    prisma.passwordResetChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored, { tokenHash: 'not-a-valid-argon2-hash' }));
    expect(await svc.loadOpen(token)).toBeNull();
  });

  it('#7 consume is atomic single-use: wins once (count 1 -> true), replay loses (count 0 -> false)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    prisma.passwordResetChallenge.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await svc.consume('c1', 5)).toBe(true);
    prisma.passwordResetChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.consume('c1', 5)).toBe(false);
  });

  it('#8 consume uses the passed tx client when given (atomic with the password change)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    const tx = { passwordResetChallenge: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    expect(await svc.consume('c1', 5, tx as never)).toBe(true);
    expect(tx.passwordResetChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'c1',
        consumedAt: null,
        factorVerifiedAt: { not: null },
        expiresAt: { gt: expect.any(Date) },
        attemptCount: { lt: 5 },
      },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prisma.passwordResetChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('#9 registerFailedAttempt increments only an un-consumed challenge (never the user)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    prisma.passwordResetChallenge.updateMany.mockResolvedValue({ count: 1 });
    await svc.registerFailedAttempt('c1', 5);
    expect(prisma.passwordResetChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'c1',
        consumedAt: null,
        expiresAt: { gt: expect.any(Date) },
        attemptCount: { lt: 5 },
      },
      data: { attemptCount: { increment: 1 } },
    });
  });

  it('#M1 markFactorVerified stamps factor_verified_at + factor_method atomically and wins once (count 1 -> true)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    prisma.passwordResetChallenge.updateMany.mockResolvedValue({ count: 1 });
    expect(await svc.markFactorVerified('c1', 'totp', 5)).toBe(true);
    expect(prisma.passwordResetChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'c1',
        consumedAt: null,
        factorVerifiedAt: null,
        expiresAt: { gt: expect.any(Date) },
        attemptCount: { lt: 5 },
      },
      data: { factorVerifiedAt: expect.any(Date), factorMethod: 'totp' },
    });
  });

  it('#M2 markFactorVerified is SET-ONCE: a second stamp / consumed challenge loses (count 0 -> false)', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    prisma.passwordResetChallenge.updateMany.mockResolvedValue({ count: 0 });
    expect(await svc.markFactorVerified('c1', 'backup_code', 5)).toBe(false);
  });

  it('#M3 markFactorVerified records the backup_code method when that factor was used', async () => {
    const prisma = makePrisma();
    const svc = new PasswordResetChallengeService(prisma as unknown as PrismaService);
    prisma.passwordResetChallenge.updateMany.mockResolvedValue({ count: 1 });
    await svc.markFactorVerified('c1', 'backup_code', 5);
    expect(prisma.passwordResetChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ factorMethod: 'backup_code' }) }),
    );
  });
});
