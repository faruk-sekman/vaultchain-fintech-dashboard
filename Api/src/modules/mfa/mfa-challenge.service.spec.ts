/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaChallengeService — PrismaService is mocked; argon2id runs for
 * real so the hash-only-storage + verify path is exercised end-to-end. Covers: opaque-token shape,
 * hash-not-plaintext storage, fail-closed reject paths (malformed/unknown/expired/consumed/exhausted/
 * wrong-secret), atomic single-use consume, the per-challenge attempt counter, and the IP/UA
 * sha-256-fingerprint-at-rest branch.
 */
import { createHash } from 'node:crypto';
import { MfaChallengeService } from './mfa-challenge.service';
import { MfaPurpose } from './mfa.constants';
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
  createdAt: Date;
}

function makePrisma(): {
  mfaChallenge: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
} {
  return {
    mfaChallenge: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  };
}

/** Mint a real challenge and capture the row the service tried to persist. */
async function mint(
  prisma: ReturnType<typeof makePrisma>,
  overrides: Partial<Pick<ChallengeRow, 'purpose' | 'maxAttempts'>> = {},
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<{ svc: MfaChallengeService; token: string; challengeId: string; stored: Record<string, unknown> }> {
  let stored: Record<string, unknown> = {};
  prisma.mfaChallenge.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    stored = args.data;
    return Promise.resolve(args.data);
  });
  const svc = new MfaChallengeService(prisma as unknown as PrismaService);
  const issued = await svc.create({
    userId: 'u1',
    purpose: (overrides.purpose as MfaPurpose) ?? MfaPurpose.Login,
    ttlSeconds: 300,
    maxAttempts: overrides.maxAttempts ?? 5,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return { svc, token: issued.token, challengeId: issued.challengeId, stored };
}

/** Build a stored row matching a minted challenge, with state overrides. */
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
    createdIpHash: null,
    uaHash: null,
    createdAt: new Date(),
    ...over,
  };
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('MfaChallengeService', () => {
  it('#1 create returns mfa_<id>.<secret> and persists ONLY the argon2id hash (never the secret)', async () => {
    const prisma = makePrisma();
    const { token, challengeId, stored } = await mint(prisma);
    expect(token.startsWith('mfa_')).toBe(true);
    expect(token.startsWith(`mfa_${challengeId}.`)).toBe(true);
    const secret = token.slice(`mfa_${challengeId}.`.length);
    expect(secret.length).toBeGreaterThan(20);
    expect(String(stored.tokenHash)).toMatch(/^\$argon2/);
    expect(String(stored.tokenHash)).not.toContain(secret); // hash, not plaintext
    expect(stored.purpose).toBe('LOGIN');
    expect(stored.maxAttempts).toBe(5);
  });

  it('#1b create with no IP/UA stores null fingerprints (no raw network signal, no hash of "")', async () => {
    const prisma = makePrisma();
    const { stored } = await mint(prisma); // ctx omitted → ip/userAgent undefined
    expect(stored.createdIpHash).toBeNull();
    expect(stored.uaHash).toBeNull();
  });

  it('#1c create with an IP + User-Agent stores their sha-256 fingerprints (no raw IP/UA at rest)', async () => {
    const prisma = makePrisma();
    const { stored } = await mint(prisma, {}, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (demo)' });
    expect(stored.createdIpHash).toBe(sha256('203.0.113.9')); // hashed, not the raw IP
    expect(stored.uaHash).toBe(sha256('Mozilla/5.0 (demo)')); // hashed, not the raw UA
    expect(stored.createdIpHash).not.toBe('203.0.113.9');
  });

  it('#2 loadOpen verifies a valid token and returns the open challenge', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);
    prisma.mfaChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored));
    const open = await svc.loadOpen(token);
    expect(open).not.toBeNull();
    expect(open?.userId).toBe('u1');
    expect(open?.purpose).toBe('LOGIN');
  });

  it('#3 loadOpen returns null for a malformed or non-UUID token (no DB hit)', async () => {
    const prisma = makePrisma();
    const svc = new MfaChallengeService(prisma as unknown as PrismaService);
    expect(await svc.loadOpen('nope')).toBeNull();
    expect(await svc.loadOpen('mfa_not-a-uuid.secret')).toBeNull();
    expect(await svc.loadOpen('mfa_.')).toBeNull();
    expect(prisma.mfaChallenge.findUnique).not.toHaveBeenCalled();
  });

  it('#4 loadOpen returns null for unknown / expired / consumed / attempt-exhausted (fail-closed)', async () => {
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);

    prisma.mfaChallenge.findUnique.mockResolvedValueOnce(null); // unknown
    expect(await svc.loadOpen(token)).toBeNull();

    prisma.mfaChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { expiresAt: new Date(Date.now() - 1) }));
    expect(await svc.loadOpen(token)).toBeNull(); // expired

    prisma.mfaChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { consumedAt: new Date() }));
    expect(await svc.loadOpen(token)).toBeNull(); // consumed

    prisma.mfaChallenge.findUnique.mockResolvedValueOnce(rowFor(challengeId, stored, { attemptCount: 5, maxAttempts: 5 }));
    expect(await svc.loadOpen(token)).toBeNull(); // exhausted
  });

  it('#5 loadOpen returns null when the secret does not match the stored hash', async () => {
    const prisma = makePrisma();
    const { challengeId, stored } = await mint(prisma);
    prisma.mfaChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored));
    const svc = new MfaChallengeService(prisma as unknown as PrismaService);
    const forged = `mfa_${challengeId}.${'A'.repeat(43)}`; // right id, wrong secret
    expect(await svc.loadOpen(forged)).toBeNull();
  });

  it('#5b loadOpen swallows an argon2 reject on a corrupt stored hash and returns null (the `.catch(() => false)` arm)', async () => {
    // A still-open challenge whose tokenHash is not a valid argon2 string makes the REAL argon2 `verify`
    // REJECT; the `.catch(() => false)` must fail closed to null, indistinguishable from a wrong secret.
    // Genuine corrupt-row error path, not coverage padding.
    const prisma = makePrisma();
    const { svc, token, challengeId, stored } = await mint(prisma);
    prisma.mfaChallenge.findUnique.mockResolvedValue(rowFor(challengeId, stored, { tokenHash: 'not-a-valid-argon2-hash' }));
    expect(await svc.loadOpen(token)).toBeNull();
  });

  it('#6 consume is atomic single-use: wins once (count 1 → true), replay loses (count 0 → false)', async () => {
    const prisma = makePrisma();
    const svc = new MfaChallengeService(prisma as unknown as PrismaService);
    prisma.mfaChallenge.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await svc.consume('c1')).toBe(true);
    prisma.mfaChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await svc.consume('c1')).toBe(false);
  });

  it('#7 registerFailedAttempt increments only an un-consumed challenge', async () => {
    const prisma = makePrisma();
    const svc = new MfaChallengeService(prisma as unknown as PrismaService);
    prisma.mfaChallenge.updateMany.mockResolvedValue({ count: 1 });
    await svc.registerFailedAttempt('c1');
    expect(prisma.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', consumedAt: null },
      data: { attemptCount: { increment: 1 } },
    });
  });
});
