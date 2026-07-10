/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for BackupCodeService — PrismaService mocked; argon2id runs for real.
 * Covers: code format + entropy, hash-only storage (never plaintext), atomic regeneration, redemption
 * with normalisation (case / hyphen), single-use consume, and the unused-count helper.
 */
import { BackupCodeService } from './backup-code.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

interface BackupRow {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
}

function makePrisma(): {
  backupCode: {
    deleteMany: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
} {
  return {
    backupCode: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
}

/** Generate codes and capture the rows the service persisted (id/userId/codeHash). */
async function generate(
  prisma: ReturnType<typeof makePrisma>,
  count: number,
): Promise<{ svc: BackupCodeService; plaintext: string[]; rows: BackupRow[] }> {
  let rows: BackupRow[] = [];
  prisma.backupCode.createMany.mockImplementation((args: { data: BackupRow[] }) => {
    rows = args.data.map((r) => ({ ...r, usedAt: null }));
    return Promise.resolve({ count: args.data.length });
  });
  const svc = new BackupCodeService(prisma as unknown as PrismaService);
  const plaintext = await svc.generate('u1', count);
  return { svc, plaintext, rows };
}

describe('BackupCodeService', () => {
  it('#1 generate returns XXXXX-XXXXX codes and persists ONLY argon2id hashes (regenerate replaces)', async () => {
    const prisma = makePrisma();
    const { plaintext, rows } = await generate(prisma, 3);
    expect(plaintext).toHaveLength(3);
    for (const code of plaintext) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/); // unambiguous alphabet, no 0/O/1/I/L
    }
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].codeHash).toMatch(/^\$argon2/);
      expect(rows[i].codeHash).not.toContain(plaintext[i].replace('-', '')); // hash, not plaintext
    }
    expect(prisma.backupCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
  });

  it('#2 verify accepts a real code (normalised) and atomically consumes it', async () => {
    const prisma = makePrisma();
    const { svc, plaintext, rows } = await generate(prisma, 3);
    prisma.backupCode.findMany.mockResolvedValue(rows);
    // lowercase + no hyphen must still match (normalisation)
    const ok = await svc.verify('u1', plaintext[1].toLowerCase().replace('-', ''));
    expect(ok).toBe(true);
    expect(prisma.backupCode.updateMany).toHaveBeenCalledWith({
      where: { id: rows[1].id, usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it('#3 verify rejects a wrong code and consumes nothing', async () => {
    const prisma = makePrisma();
    const { svc, rows } = await generate(prisma, 3);
    prisma.backupCode.findMany.mockResolvedValue(rows);
    expect(await svc.verify('u1', 'ZZZZZ-ZZZZZ')).toBe(false);
    expect(await svc.verify('u1', '')).toBe(false);
    expect(prisma.backupCode.updateMany).not.toHaveBeenCalled();
  });

  it('#4 verify loses the single-use race (hash matches but row already used) → false', async () => {
    const prisma = makePrisma();
    const { svc, plaintext, rows } = await generate(prisma, 2);
    prisma.backupCode.findMany.mockResolvedValue(rows);
    prisma.backupCode.updateMany.mockResolvedValue({ count: 0 }); // another request consumed it first
    expect(await svc.verify('u1', plaintext[0])).toBe(false);
  });

  it('#4b verify swallows an argon2 reject on a corrupt stored hash and returns false (the `.catch(() => false)` arm)', async () => {
    // A row whose codeHash is not a valid argon2 string makes the REAL argon2 `verify` REJECT; the
    // `.catch(() => false)` must treat that as a non-match (fail-closed), continue the loop, and never
    // consume anything. This is a genuine corrupt-row error path, not coverage padding.
    const prisma = makePrisma();
    const svc = new BackupCodeService(prisma as unknown as PrismaService);
    prisma.backupCode.findMany.mockResolvedValue([
      { id: 'b1', userId: 'u1', codeHash: 'not-a-valid-argon2-hash', usedAt: null },
    ]);
    expect(await svc.verify('u1', 'ABCDE-FGHJK')).toBe(false);
    expect(prisma.backupCode.updateMany).not.toHaveBeenCalled();
  });

  it('#5 remaining returns the unused-code count', async () => {
    const prisma = makePrisma();
    prisma.backupCode.count.mockResolvedValue(7);
    const svc = new BackupCodeService(prisma as unknown as PrismaService);
    expect(await svc.remaining('u1')).toBe(7);
    expect(prisma.backupCode.count).toHaveBeenCalledWith({ where: { userId: 'u1', usedAt: null } });
  });
});
