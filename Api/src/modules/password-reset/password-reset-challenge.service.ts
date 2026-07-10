/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset challenge service. A near-verbatim clone of
 * MfaChallengeService: the reset challenge is the short-lived second-factor gate issued between a
 * self-service "I forgot my password" request and a credential change. It is a DB-backed SINGLE-USE
 * OPAQUE token `pwr_<id>.<secret>` (mirrors the MfaChallenge / RefreshToken pattern): only the
 * argon2id hash of the secret is stored, so the DB never holds a usable token. SINGLE-USE is enforced
 * atomically via `consumed_at IS NULL`. Brute-force resistance is per-challenge
 * (`attempt_count`/`max_attempts`) with NO persistent per-account lockout — THE VICTIM ACCOUNT IS
 * NEVER LOCKED by reset attempts (DoS-safe; an attacker must not be able to lock a victim out of their
 * own account via the reset endpoint). Fail-closed: every reject path returns `null`, never an
 * exception that could leak which check failed. Secrets/tokens are never returned in DTOs or logged.
 *
 * The 2nd factor is verified ONCE at POST /auth/password/reset/verify-code, which calls
 * `markFactorVerified` to atomically stamp `factor_verified_at` (SET-ONCE, mirrors `consume`'s
 * single-winner guard); the later password-only /verify is gated on that stamp.
 */
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { isUuid, uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PWRESET_CHALLENGE_TOKEN_PREFIX, PasswordResetPurpose, ResetMethod } from './password-reset.constants';

/** Result of minting a challenge: the opaque token goes to the client; the secret is never stored. */
export interface IssuedResetChallenge {
  /** `pwr_<id>.<secret>` — carried in the httpOnly `ftd_pwreset` cookie. Never persisted, never logged. */
  token: string;
  challengeId: string;
  expiresAt: Date;
}

/** A validated, still-open challenge (secret verified; not expired/consumed/attempt-exhausted). */
export interface OpenResetChallenge {
  id: string;
  userId: string;
  purpose: PasswordResetPurpose;
  attemptCount: number;
  maxAttempts: number;
  /** sha256(client ip) bound at issue — the verify step enforces the same fingerprint. */
  createdIpHash: string | null;
  /** sha256(user-agent) bound at issue — the verify step enforces the same fingerprint. */
  uaHash: string | null;
  /** Stamped once the 2nd factor passed at verify-code; null = factor not yet proven. */
  factorVerifiedAt: Date | null;
  /** Which factor was stamped at verify-code ('totp' | 'backup_code'); null until the factor is proven. */
  factorMethod: string | null;
}

export interface CreateResetChallengeInput {
  userId: string;
  purpose: PasswordResetPurpose;
  ttlSeconds: number;
  maxAttempts: number;
  /** Raw client IP — stored only as a sha-256 fingerprint (no raw IP at rest). */
  ip?: string;
  /** Raw User-Agent — stored only as a sha-256 fingerprint. */
  userAgent?: string;
}

@Injectable()
export class PasswordResetChallengeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a single-use challenge: persist ONLY the argon2id hash of a high-entropy secret and return
   * the opaque `pwr_<id>.<secret>` token (the secret never touches the DB). No per-account state is
   * created that an attacker could exhaust, so minting a challenge can never lock out the victim.
   */
  async create(input: CreateResetChallengeInput): Promise<IssuedResetChallenge> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    await this.prisma.passwordResetChallenge.create({
      data: {
        id,
        tokenHash: await hash(secret),
        userId: input.userId,
        purpose: input.purpose,
        expiresAt,
        maxAttempts: input.maxAttempts,
        createdIpHash: input.ip ? sha256(input.ip) : null,
        uaHash: input.userAgent ? sha256(input.userAgent) : null,
      },
    });
    return { token: `${PWRESET_CHALLENGE_TOKEN_PREFIX}${id}.${secret}`, challengeId: id, expiresAt };
  }

  /**
   * Validate a presented opaque token and return the open challenge, or `null` if it is malformed,
   * unknown, expired, already consumed, or attempt-exhausted. Fail-closed: a single `null` covers
   * every reject so the caller cannot distinguish (no enumeration of challenge state).
   */
  async loadOpen(presented: string): Promise<OpenResetChallenge | null> {
    const parsed = parseToken(presented);
    if (!parsed) return null;
    const row = await this.prisma.passwordResetChallenge.findUnique({ where: { id: parsed.id } });
    if (!row) return null;
    if (row.consumedAt || row.expiresAt.getTime() <= Date.now() || row.attemptCount >= row.maxAttempts) {
      return null;
    }
    if (!(await verify(row.tokenHash, parsed.secret).catch(() => false))) return null;
    return {
      id: row.id,
      userId: row.userId,
      purpose: row.purpose as PasswordResetPurpose,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      createdIpHash: row.createdIpHash,
      uaHash: row.uaHash,
      factorVerifiedAt: row.factorVerifiedAt,
      factorMethod: row.factorMethod,
    };
  }

  /**
   * Stamp the second factor as verified on an OPEN challenge — SET-ONCE and atomic (the
   * `factor_verified_at IS NULL` guard mirrors consume()'s single-winner pattern). Returns `true` only
   * for the caller that wins the stamp; a replayed/concurrent stamp returns `false`, so a factor is
   * recorded at most once and two racing verify-code calls cannot both pass and double-spend a backup
   * code. NEVER touches consumed/attempt state — the later password step consumes the challenge.
   */
  async markFactorVerified(challengeId: string, method: ResetMethod, maxAttempts: number): Promise<boolean> {
    const { count } = await this.prisma.passwordResetChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        factorVerifiedAt: null,
        expiresAt: { gt: new Date() },
        attemptCount: { lt: maxAttempts },
      },
      data: { factorVerifiedAt: new Date(), factorMethod: method },
    });
    return count === 1;
  }

  /**
   * Atomically consume the challenge on a successful second factor. Returns `true` only for the
   * caller that wins the `consumed_at IS NULL` race — a replayed or concurrent consume returns
   * `false`, so one challenge can authorize a reset at most once. A `tx` may be passed so the
   * consume is atomic with the password change (the success transaction).
   */
  async consume(challengeId: string, maxAttempts: number, tx?: PrismaTxClient): Promise<boolean> {
    const client = tx ?? this.prisma;
    const { count } = await client.passwordResetChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        factorVerifiedAt: { not: null },
        expiresAt: { gt: new Date() },
        attemptCount: { lt: maxAttempts },
      },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Count a failed factor attempt. Only an un-consumed challenge is incremented; once `attempt_count`
   * reaches `max_attempts` the challenge fails closed in `loadOpen`. This NEVER touches the user's
   * `failed_login_count` / `locked_until` — the victim is never locked by reset attempts.
   */
  async registerFailedAttempt(challengeId: string, maxAttempts: number): Promise<void> {
    await this.prisma.passwordResetChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attemptCount: { lt: maxAttempts },
      },
      data: { attemptCount: { increment: 1 } },
    });
  }
}

/** Minimal transaction-client surface this service needs (so `consume` can run inside `$transaction`). */
type PrismaTxClient = {
  passwordResetChallenge: { updateMany: PrismaService['passwordResetChallenge']['updateMany'] };
};

/** Parse `pwr_<uuid>.<secret>`; returns `null` on any structural problem (fail-closed). */
function parseToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(PWRESET_CHALLENGE_TOKEN_PREFIX)) return null;
  const rest = token.slice(PWRESET_CHALLENGE_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!isUuid(id) || !secret) return null;
  return { id, secret };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
