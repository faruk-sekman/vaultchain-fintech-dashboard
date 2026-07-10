/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Backup-code service. One-time recovery codes for when the authenticator
 * is unavailable. Codes are high-entropy (~50 bits) from an unambiguous alphabet (no 0/O/1/I/L) in the
 * form XXXXX-XXXXX; only their argon2id hashes are stored, and the plaintext is returned exactly ONCE
 * at generation (never persisted, never logged). SINGLE-USE is enforced atomically via `used_at IS
 * NULL`. Regeneration replaces the whole set in one transaction. Lookups normalise input (uppercase,
 * strip separators) so a code is accepted regardless of case or the hyphen.
 */
import { Injectable } from '@nestjs/common';
import { hash, verify as argonVerify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

// Unambiguous Crockford-style alphabet: no 0/O/1/I/L. 31 symbols × 10 chars ≈ 49.5 bits of entropy.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 10;

@Injectable()
export class BackupCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint `count` one-time codes for the user: store ONLY their argon2id hashes and return the
   * plaintext set ONCE for the user to save. Replaces any existing codes atomically (regeneration),
   * so a fresh set always invalidates the old one.
   */
  async generate(userId: string, count: number): Promise<string[]> {
    const plaintext = Array.from({ length: count }, () => randomCode());
    const rows = await Promise.all(
      plaintext.map(async (code) => ({ id: uuidv7(), userId, codeHash: await hash(normalize(code)) })),
    );
    await this.prisma.$transaction([
      this.prisma.backupCode.deleteMany({ where: { userId } }),
      this.prisma.backupCode.createMany({ data: rows }),
    ]);
    return plaintext;
  }

  /**
   * Redeem a backup code: argon2id-compare the (normalised) input against the user's UNUSED codes and,
   * on a match, atomically stamp `used_at` so the code cannot be reused. Returns false for no match or
   * a code that loses the single-use race. The hashes are salted, so there is no hash lookup — every
   * unused code is checked (bounded by the small per-user set).
   */
  async verify(userId: string, code: string): Promise<boolean> {
    const candidate = normalize(code);
    if (!candidate) return false;
    const unused = await this.prisma.backupCode.findMany({ where: { userId, usedAt: null } });
    for (const row of unused) {
      if (await argonVerify(row.codeHash, candidate).catch(() => false)) {
        const { count } = await this.prisma.backupCode.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return count === 1;
      }
    }
    return false;
  }

  /** How many unused recovery codes the user has left (for a "regenerate soon" UI hint). */
  async remaining(userId: string): Promise<number> {
    return this.prisma.backupCode.count({ where: { userId, usedAt: null } });
  }
}

/** A single XXXXX-XXXXX code from the unambiguous alphabet using unbiased crypto randomness. */
function randomCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Canonical form for hashing + comparison: uppercase, separators/whitespace stripped. */
function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
