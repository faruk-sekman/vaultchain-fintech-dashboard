/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * MFA challenge service. The challenge is the short-lived second-factor
 * gate issued between a verified password and a granted session. It is a DB-backed SINGLE-USE OPAQUE
 * token `mfa_<id>.<secret>` (mirrors the RefreshToken pattern): only the argon2id hash of the secret
 * is stored, so the DB never holds a usable token. SINGLE-USE is enforced atomically via
 * `consumed_at IS NULL`. Brute-force resistance is per-challenge (`attempt_count`/`max_attempts`) with
 * NO persistent per-account lockout — an attacker must not be able to lock out a victim (DoS-safe).
 * Fail-closed: every reject path returns `null`, never an exception that could leak which check failed.
 * Secrets/tokens are never returned in DTOs or logged.
 */
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { isUuid, uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MFA_CHALLENGE_TOKEN_PREFIX, MfaPurpose } from './mfa.constants';

/** Result of minting a challenge: the opaque token goes to the client; the secret is never stored. */
export interface IssuedChallenge {
  /** `mfa_<id>.<secret>` — carried in the httpOnly `ftd_mfa` cookie. Never persisted, never logged. */
  token: string;
  challengeId: string;
  expiresAt: Date;
}

/** A validated, still-open challenge (secret verified; not expired/consumed/attempt-exhausted). */
export interface OpenChallenge {
  id: string;
  userId: string;
  purpose: MfaPurpose;
  attemptCount: number;
  maxAttempts: number;
}

export interface CreateChallengeInput {
  userId: string;
  purpose: MfaPurpose;
  ttlSeconds: number;
  maxAttempts: number;
  /** Raw client IP — stored only as a sha-256 fingerprint (no raw IP at rest). */
  ip?: string;
  /** Raw User-Agent — stored only as a sha-256 fingerprint. */
  userAgent?: string;
}

@Injectable()
export class MfaChallengeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a single-use challenge: persist ONLY the argon2id hash of a high-entropy secret and return
   * the opaque `mfa_<id>.<secret>` token (the secret never touches the DB). No per-account state is
   * created that an attacker could exhaust, so minting a challenge can never lock out the victim.
   */
  async create(input: CreateChallengeInput): Promise<IssuedChallenge> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    await this.prisma.mfaChallenge.create({
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
    return { token: `${MFA_CHALLENGE_TOKEN_PREFIX}${id}.${secret}`, challengeId: id, expiresAt };
  }

  /**
   * Validate a presented opaque token and return the open challenge, or `null` if it is malformed,
   * unknown, expired, already consumed, or attempt-exhausted. Fail-closed: a single `null` covers
   * every reject so the caller cannot distinguish (no enumeration of challenge state).
   */
  async loadOpen(presented: string): Promise<OpenChallenge | null> {
    const parsed = parseToken(presented);
    if (!parsed) return null;
    const row = await this.prisma.mfaChallenge.findUnique({ where: { id: parsed.id } });
    if (!row) return null;
    if (row.consumedAt || row.expiresAt.getTime() <= Date.now() || row.attemptCount >= row.maxAttempts) {
      return null;
    }
    if (!(await verify(row.tokenHash, parsed.secret).catch(() => false))) return null;
    return {
      id: row.id,
      userId: row.userId,
      purpose: row.purpose as MfaPurpose,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
    };
  }

  /**
   * Atomically consume the challenge on a successful second factor. Returns `true` only for the
   * caller that wins the `consumed_at IS NULL` race — a replayed or concurrent consume returns
   * `false`, so one challenge can upgrade a session at most once.
   */
  async consume(challengeId: string, maxAttempts: number): Promise<boolean> {
    const { count } = await this.prisma.mfaChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attemptCount: { lt: maxAttempts },
      },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Count a failed code attempt. Only an un-consumed challenge is incremented; once `attempt_count`
   * reaches `max_attempts` the challenge fails closed in `loadOpen` (no per-account lockout).
   */
  async registerFailedAttempt(challengeId: string, maxAttempts: number): Promise<void> {
    await this.prisma.mfaChallenge.updateMany({
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

/** Parse `mfa_<uuid>.<secret>`; returns `null` on any structural problem (fail-closed). */
function parseToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(MFA_CHALLENGE_TOKEN_PREFIX)) return null;
  const rest = token.slice(MFA_CHALLENGE_TOKEN_PREFIX.length);
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
