/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Remembered-device service. Optional "remember this device" so a known
 * device can skip the TOTP prompt until expiry — feature-flagged OFF by default (MFA_REMEMBER_DEVICE_
 * ENABLED). The device token is an opaque `rd_<id>.<secret>` (mirrors the challenge/refresh pattern):
 * only the argon2id hash of the secret is stored. The User-Agent and IP are WEAK signals — a coarse
 * `ip_prefix` (not a full IP) and a sha-256 UA fingerprint bound at issue: a mismatch DOWNGRADES to
 * "require MFA" (returns null), never a hard error, so roaming/UA changes don't lock a user out.
 * Secrets/tokens are never returned in DTOs or logged.
 */
import { Injectable, Logger } from '@nestjs/common';
import { hash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { isUuid, uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const TOKEN_PREFIX = 'rd_';

/** Name of the httpOnly cookie that carries the remember-device trust token. */
export const REMEMBER_COOKIE_NAME = 'ftd_remember';
/** Path scope: the remember-device cookie is only ever sent to the auth endpoints. */
export const REMEMBER_COOKIE_PATH = '/api/v1/auth';

/** httpOnly cookie attributes for the remember-device token (mirrors the refresh-cookie posture). */
export function rememberCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: REMEMBER_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  };
}

export interface IssuedDevice {
  /** `rd_<id>.<secret>` — carried in the httpOnly `ftd_remember` cookie. Never persisted, never logged. */
  token: string;
  deviceId: string;
  expiresAt: Date;
}

export interface DeviceContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class RememberedDeviceService {
  /** Debug-only diagnostics for the silent fail-closed verify path (A17). NEVER logs UA/IP/token. */
  private readonly logger = new Logger(RememberedDeviceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Mint a device-trust token: store ONLY the argon2id hash + the coarse UA/IP fingerprints. */
  async issue(userId: string, ttlSeconds: number, ctx: DeviceContext): Promise<IssuedDevice> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.prisma.rememberedDevice.create({
      data: {
        id,
        userId,
        tokenHash: await hash(secret),
        uaHash: sha256(ctx.userAgent ?? ''),
        ipPrefix: ipPrefix(ctx.ip),
        expiresAt,
      },
    });
    return { token: `${TOKEN_PREFIX}${id}.${secret}`, deviceId: id, expiresAt };
  }

  /**
   * Validate a presented device token against the current request context. Returns the userId ONLY
   * when the token verifies AND is not expired/revoked AND the weak UA/IP fingerprints still match.
   * Any failure (malformed/unknown/expired/revoked/wrong-secret/UA-or-IP drift) returns `null`, so the
   * caller simply requires the full second factor — fail-closed, never throwing.
   */
  async verify(presented: string, ctx: DeviceContext): Promise<{ userId: string } | null> {
    // Each fail-closed branch logs a PII-free reason at DEBUG (A17): only the random device id and
    // boolean flags — never the UA string, IP, or any token material — so a silently skipped
    // trusted-device fast-path is diagnosable in dev without weakening the no-PII log posture.
    const parsed = parseToken(presented);
    if (!parsed) {
      this.logger.debug('remember-device verify: malformed token');
      return null;
    }
    const row = await this.prisma.rememberedDevice.findUnique({ where: { id: parsed.id } });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      const reason = !row ? 'unknown' : row.revokedAt ? 'revoked' : 'expired';
      this.logger.debug(`remember-device verify: device ${parsed.id} ${reason}`);
      return null;
    }
    if (!(await argonVerify(row.tokenHash, parsed.secret).catch(() => false))) {
      this.logger.debug(`remember-device verify: device ${parsed.id} secret mismatch`);
      return null;
    }
    // Weak signals: a UA/IP mismatch downgrades to "require MFA" (null), not an error.
    const uaMatch = row.uaHash === sha256(ctx.userAgent ?? '');
    const ipMatch = row.ipPrefix === ipPrefix(ctx.ip);
    if (!uaMatch || !ipMatch) {
      this.logger.debug(
        `remember-device verify: device ${parsed.id} fingerprint drift (uaMatch=${uaMatch}, ipMatch=${ipMatch})`,
      );
      return null;
    }
    return { userId: row.userId };
  }

  /** Revoke one device (idempotent). Used by logout-this-device and the management endpoints. */
  async revoke(deviceId: string): Promise<void> {
    await this.prisma.rememberedDevice.updateMany({
      where: { id: deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke every remembered device for a user — the hook fired on password change / MFA disable / reset. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.rememberedDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke ONE device, scoped to its owner (the self-service DELETE endpoint — never another user's). */
  async revokeForUser(userId: string, deviceId: string): Promise<void> {
    await this.prisma.rememberedDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke the device a presented token identifies (logout de-trust). Best-effort; a bad token is a no-op. */
  async revokeByToken(presented: string): Promise<void> {
    const parsed = parseToken(presented);
    if (parsed) await this.revoke(parsed.id);
  }

  /** The user's active (non-revoked, non-expired) remembered devices, for the self-service list. */
  listActiveForUser(userId: string): Promise<Array<{ id: string; createdAt: Date; expiresAt: Date; ipPrefix: string }>> {
    return this.prisma.rememberedDevice.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true, ipPrefix: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}

/** Parse `rd_<uuid>.<secret>`; returns `null` on any structural problem (fail-closed). */
function parseToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const id = rest.slice(0, dot);
  const secret = rest.slice(dot + 1);
  if (!isUuid(id) || !secret) return null;
  return { id, secret };
}

/**
 * Coarse network prefix bound at issue to limit token portability WITHOUT pinning a full IP (which
 * would break roaming/CGNAT users): IPv4 → /24 (first three octets), IPv6 → /48 (first three hextets).
 * Unknown/empty input collapses to '' — still a consistent, comparable weak signal.
 */
function ipPrefix(ip?: string): string {
  if (!ip) return '';
  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  }
  const octets = ip.split('.');
  return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : ip;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
