/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for RememberedDeviceService — PrismaService mocked; argon2id runs for
 * real. Covers: opaque-token shape, hash-only storage, coarse ip_prefix (/24 + /48 + the empty/odd
 * fallbacks), verify success (incl. the no-UA path), the UA/IP weak-signal downgrade (mismatch → null,
 * never an error), expired/revoked/wrong-secret/malformed/corrupt-hash rejects, the cookie attributes,
 * single + all-for-user + per-user + by-token revocation, and the active-device listing.
 */
import { RememberedDeviceService, REMEMBER_COOKIE_NAME, REMEMBER_COOKIE_PATH, rememberCookieOptions } from './remembered-device.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';

interface DeviceRow {
  id: string;
  userId: string;
  tokenHash: string;
  uaHash: string;
  ipPrefix: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function makePrisma(): {
  rememberedDevice: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
} {
  return {
    rememberedDevice: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

const CTX = { ip: '203.0.113.42', userAgent: 'Mozilla/5.0 (demo)' };

/** Issue a device and capture the persisted row. */
async function issue(
  prisma: ReturnType<typeof makePrisma>,
  ctx: { ip?: string; userAgent?: string } = CTX,
): Promise<{ svc: RememberedDeviceService; token: string; deviceId: string; stored: Record<string, unknown> }> {
  let stored: Record<string, unknown> = {};
  prisma.rememberedDevice.create.mockImplementation((args: { data: Record<string, unknown> }) => {
    stored = args.data;
    return Promise.resolve(args.data);
  });
  const svc = new RememberedDeviceService(prisma as unknown as PrismaService);
  const issued = await svc.issue('u1', 60, ctx);
  return { svc, token: issued.token, deviceId: issued.deviceId, stored };
}

function rowFor(deviceId: string, stored: Record<string, unknown>, over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: deviceId,
    userId: 'u1',
    tokenHash: String(stored.tokenHash),
    uaHash: String(stored.uaHash),
    ipPrefix: String(stored.ipPrefix),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    ...over,
  };
}

describe('RememberedDeviceService', () => {
  it('#1 issue returns rd_<id>.<secret>, stores only the argon2id hash + a COARSE /24 ip prefix', async () => {
    const prisma = makePrisma();
    const { token, deviceId, stored } = await issue(prisma);
    expect(token.startsWith(`rd_${deviceId}.`)).toBe(true);
    const secret = token.slice(`rd_${deviceId}.`.length);
    expect(String(stored.tokenHash)).toMatch(/^\$argon2/);
    expect(String(stored.tokenHash)).not.toContain(secret);
    expect(stored.ipPrefix).toBe('203.0.113.0/24'); // /24, not the full 203.0.113.42
    expect(String(stored.uaHash)).toHaveLength(64); // sha-256 hex, not the raw UA
  });

  it('#1b issue with an IPv6 address records a /48 coarse prefix; missing UA/IP collapse to safe defaults', async () => {
    const v6 = await issue(makePrisma(), { ip: '2001:db8:abcd:1234::1', userAgent: 'ua' });
    expect(v6.stored.ipPrefix).toBe('2001:db8:abcd::/48'); // first three hextets, /48

    const none = await issue(makePrisma(), {}); // no ip, no userAgent
    expect(none.stored.ipPrefix).toBe(''); // empty → consistent comparable weak signal
    expect(String(none.stored.uaHash)).toHaveLength(64); // sha-256 of '' is still a 64-hex digest

    const odd = await issue(makePrisma(), { ip: 'not.an.ip' }); // not 4 octets, no ':'
    expect(odd.stored.ipPrefix).toBe('not.an.ip'); // odd shape returned as-is (the non-/24 else arm)
  });

  it('#2 verify returns the userId for a valid token with matching UA/IP', async () => {
    const prisma = makePrisma();
    const { svc, token, deviceId, stored } = await issue(prisma);
    prisma.rememberedDevice.findUnique.mockResolvedValue(rowFor(deviceId, stored));
    expect(await svc.verify(token, CTX)).toEqual({ userId: 'u1' });
  });

  it('#2b verify succeeds for a device issued + presented with NO User-Agent (the `?? ""` default on both sides)', async () => {
    // A request with no UA hashes the empty string consistently at issue AND verify, so a UA-less device
    // still matches itself — exercising the verify-side `sha256(ctx.userAgent ?? "")` default arm.
    const prisma = makePrisma();
    const { svc, token, deviceId, stored } = await issue(prisma, { ip: '203.0.113.42' }); // userAgent omitted
    prisma.rememberedDevice.findUnique.mockResolvedValue(rowFor(deviceId, stored));
    expect(await svc.verify(token, { ip: '203.0.113.42' })).toEqual({ userId: 'u1' }); // also no UA
  });

  it('#3 weak-signal downgrade: a UA or IP mismatch returns null (require MFA, NOT an error)', async () => {
    const prisma = makePrisma();
    const { svc, token, deviceId, stored } = await issue(prisma);
    prisma.rememberedDevice.findUnique.mockResolvedValue(rowFor(deviceId, stored));
    expect(await svc.verify(token, { ip: CTX.ip, userAgent: 'different-agent' })).toBeNull();
    expect(await svc.verify(token, { ip: '198.51.100.7', userAgent: CTX.userAgent })).toBeNull(); // different /24, UA matches
  });

  it('#4 verify returns null for expired / revoked / wrong-secret / malformed', async () => {
    const prisma = makePrisma();
    const { svc, token, deviceId, stored } = await issue(prisma);

    prisma.rememberedDevice.findUnique.mockResolvedValueOnce(rowFor(deviceId, stored, { expiresAt: new Date(Date.now() - 1) }));
    expect(await svc.verify(token, CTX)).toBeNull(); // expired

    prisma.rememberedDevice.findUnique.mockResolvedValueOnce(rowFor(deviceId, stored, { revokedAt: new Date() }));
    expect(await svc.verify(token, CTX)).toBeNull(); // revoked

    prisma.rememberedDevice.findUnique.mockResolvedValueOnce(rowFor(deviceId, stored));
    expect(await svc.verify(`rd_${deviceId}.${'A'.repeat(43)}`, CTX)).toBeNull(); // wrong secret

    expect(await svc.verify('not-a-token', CTX)).toBeNull(); // malformed prefix (no DB hit)
    expect(await svc.verify(`rd_${deviceId}`, CTX)).toBeNull(); // no `.` separator → parse fail
    expect(await svc.verify('rd_not-a-uuid.secret', CTX)).toBeNull(); // non-UUID id → parse fail
  });

  it('#4b verify returns null when the stored hash is corrupt (argon verify rejects → caught → null)', async () => {
    const prisma = makePrisma();
    const { svc, token, deviceId, stored } = await issue(prisma);
    // A malformed argon hash makes `argonVerify` reject; the `.catch(() => false)` arm must fail closed.
    prisma.rememberedDevice.findUnique.mockResolvedValue(rowFor(deviceId, stored, { tokenHash: 'not-an-argon-hash' }));
    expect(await svc.verify(token, CTX)).toBeNull();
  });

  it('#5 revoke / revokeAllForUser only touch un-revoked rows', async () => {
    const prisma = makePrisma();
    const svc = new RememberedDeviceService(prisma as unknown as PrismaService);
    await svc.revoke('d1');
    expect(prisma.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    await svc.revokeAllForUser('u1');
    expect(prisma.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('#6 revokeForUser scopes the revoke to the owner (never another user’s device)', async () => {
    const prisma = makePrisma();
    const svc = new RememberedDeviceService(prisma as unknown as PrismaService);
    await svc.revokeForUser('u1', 'd9');
    expect(prisma.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { id: 'd9', userId: 'u1', revokedAt: null }, // owner-scoped
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('#7 revokeByToken revokes the identified device for a well-formed token, and is a no-op for a bad one', async () => {
    const prisma = makePrisma();
    const { svc, token, deviceId } = await issue(prisma);

    await svc.revokeByToken(token);
    expect(prisma.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { id: deviceId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

    prisma.rememberedDevice.updateMany.mockClear();
    await svc.revokeByToken('garbage'); // unparseable → best-effort no-op
    expect(prisma.rememberedDevice.updateMany).not.toHaveBeenCalled();
  });

  it('#8 listActiveForUser queries only non-revoked, non-expired devices for the user, newest first', async () => {
    const prisma = makePrisma();
    const svc = new RememberedDeviceService(prisma as unknown as PrismaService);
    prisma.rememberedDevice.findMany.mockResolvedValue([
      { id: 'd2', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ipPrefix: '203.0.113.0/24' },
    ]);
    const list = await svc.listActiveForUser('u1');
    expect(list).toHaveLength(1);
    expect(prisma.rememberedDevice.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null, expiresAt: { gt: expect.any(Date) } },
      select: { id: true, createdAt: true, expiresAt: true, ipPrefix: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('#9 the remember cookie has the expected hardened attributes', () => {
    const opts = rememberCookieOptions(120);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: REMEMBER_COOKIE_PATH, maxAge: 120 });
    expect(typeof opts.secure).toBe('boolean'); // gated to NODE_ENV=production
    expect(REMEMBER_COOKIE_NAME).toBe('ftd_remember');
    expect(REMEMBER_COOKIE_PATH).toBe('/api/v1/auth');
  });
});
