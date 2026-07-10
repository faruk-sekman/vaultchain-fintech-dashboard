/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the authentication service. Argon2, Prisma, JWT, config and the
 * MFA collaborators are mocked so these run with no database or crypto cost. They pin the security
 * behaviours: account lockout, no-user-enumeration, the opt-in second-factor decision tree, config
 * defaulting, refresh-token rotation / reuse-detection, and the logout / token-parse guards. The DB
 * path is covered by auth.int-spec.ts.
 */
import { hash, verify } from '@node-rs/argon2';
import { AuthService, refreshCookieOptions, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from './auth.service';

jest.mock('@node-rs/argon2', () => ({
  hash: jest.fn().mockResolvedValue('argon-hash'),
  verify: jest.fn().mockResolvedValue(true),
}));

const VALID_TOKEN_ID = '0190aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const REFRESH_TOKEN = `rt_${VALID_TOKEN_ID}.secret-part`;

const fullUser = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'admin@ftd.io',
  displayName: 'Admin',
  status: 'ACTIVE',
  passwordHash: 'argon-hash',
  failedLoginCount: 0,
  lockedUntil: null,
  mfaEnabled: false,
  mfaConfirmedAt: null,
  ...over,
});

const profile = () => ({ id: 'user-1', displayName: 'Admin', email: 'admin@ftd.io', mfaEnabled: false, permissionVersion: 5 });
const rolesRow = { userRoles: [{ role: { rolePermissions: [{ permission: { code: 'customers.read' } }] } }] };

interface SetupOpts {
  user?: ReturnType<typeof fullUser> | null;
  refreshRow?: Record<string, unknown> | null;
  rememberEnabled?: boolean;
  trusted?: { userId: string } | null;
  /** Override the config so a test can exercise the `?? default` arms (returns undefined for all keys). */
  configGet?: (key: string) => unknown;
  /** Override resolvePermissions' raw row (null → the `rows?.userRoles ?? []` default arm). */
  rolesRowOverride?: unknown;
  /** Make the lazily-resolved NotificationService.emit REJECT, to prove the lockout notify is best-effort. */
  emitThrows?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const user = opts.user === undefined ? fullUser() : opts.user;
  const roles = opts.rolesRowOverride === undefined ? rolesRow : opts.rolesRowOverride;
  const prisma = {
    user: {
      // resolvePermissions asks with a userRoles select; every other lookup returns the user row.
      findUnique: jest.fn((args: { select?: { userRoles?: unknown } }) =>
        args?.select?.userRoles ? Promise.resolve(roles) : Promise.resolve(user),
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue(profile()),
      update: jest.fn().mockResolvedValue(undefined),
    },
    loginAttempt: { create: jest.fn().mockResolvedValue(undefined) },
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(opts.refreshRow ?? null),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-jwt') };
  const defaultGet = (key: string) =>
    ({ MFA_REMEMBER_DEVICE_ENABLED: opts.rememberEnabled ?? false, MFA_CHALLENGE_TTL: 300, MFA_MAX_VERIFY_ATTEMPTS: 5 })[key];
  const config = { get: jest.fn(opts.configGet ?? defaultGet) };
  const challenges = { create: jest.fn().mockResolvedValue({ token: 'challenge-token' }) };
  const remembered = { verify: jest.fn().mockResolvedValue(opts.trusted ?? null) };
  // NotificationService is resolved lazily via ModuleRef.get (the Auth↔Notification cycle dodge). `emit`
  // either resolves (default) or, when opts.emitThrows is set, rejects — to prove the lockout notification
  // is BEST-EFFORT and never breaks registerFailure.
  const notifications = {
    emit: opts.emitThrows
      ? jest.fn().mockRejectedValue(new Error('notify down'))
      : jest.fn().mockResolvedValue({ id: 'n1', deduped: false }),
  };
  const moduleRef = { get: jest.fn().mockReturnValue(notifications) };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    challenges as never,
    remembered as never,
    moduleRef as never,
  );
  return { service, prisma, jwt, config, challenges, remembered, notifications, moduleRef };
}

beforeEach(() => {
  jest.clearAllMocks();
  (verify as jest.Mock).mockResolvedValue(true);
  (hash as jest.Mock).mockResolvedValue('argon-hash');
});

describe('AuthService.login', () => {
  it('rejects a locked account with 423 before doing any password work', async () => {
    const { service, prisma } = setup({ user: fullUser({ lockedUntil: new Date(Date.now() + 60_000) }) });

    await expect(service.login('admin@ftd.io', 'pw')).rejects.toMatchObject({ response: { code: 'Auth.AccountLocked' } });
    // No password verification once locked, and the attempt is still audited.
    expect(verify).not.toHaveBeenCalled();
    expect(prisma.loginAttempt.create).toHaveBeenCalled();
  });

  it('returns the generic InvalidCredentials for an unknown user (no enumeration)', async () => {
    const { service, prisma } = setup({ user: null });

    await expect(service.login('ghost@ftd.io', 'pw')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    // Audited as an unknown user: emailHash recorded, no userId.
    expect(prisma.loginAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null, success: false }) }),
    );
  });

  it('counts a wrong password as a failure and increments the counter (and does NOT notify before lockout)', async () => {
    (verify as jest.Mock).mockResolvedValue(false);
    const { service, prisma, notifications } = setup({ user: fullUser({ failedLoginCount: 0 }) });

    await expect(service.login('admin@ftd.io', 'wrong')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 1, lockedUntil: null }) }),
    );
    // A non-locking failure (failed=1 < MAX_FAILED_LOGINS) must emit NO lockout notification.
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('does NOT emit a lockout notification on the 4th failure (the one just below the threshold)', async () => {
    // failed = 4 → still < MAX_FAILED_LOGINS (5): the account is not yet locked, so no notification.
    (verify as jest.Mock).mockResolvedValue(false);
    const { service, prisma, notifications } = setup({ user: fullUser({ failedLoginCount: 3 }) });

    await expect(service.login('admin@ftd.io', 'wrong')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    expect(prisma.user.update.mock.calls[0][0].data.lockedUntil).toBeNull();
    expect(notifications.emit).not.toHaveBeenCalled();
  });

  it('locks the account on the 5th consecutive failure and emits a critical lockout SECURITY_ALERT to the locked user', async () => {
    (verify as jest.Mock).mockResolvedValue(false);
    const { service, prisma, notifications } = setup({ user: fullUser({ failedLoginCount: 4 }) });

    await expect(service.login('admin@ftd.io', 'wrong')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    const update = prisma.user.update.mock.calls[0][0];
    expect(update.data.failedLoginCount).toBe(5);
    expect(update.data.lockedUntil).toBeInstanceOf(Date);
    // The lockout transition (failed >= MAX_FAILED_LOGINS) fires exactly one notification, to the LOCKED
    // user, PII-FREE (params {}), deduped per user, with the SECURITY_ALERT/critical contract.
    expect(notifications.emit).toHaveBeenCalledTimes(1);
    expect(notifications.emit).toHaveBeenCalledWith({
      recipientUserId: 'user-1',
      type: 'SECURITY_ALERT',
      severity: 'critical',
      titleKey: 'notifications.security.accountLockout.title',
      bodyKey: 'notifications.security.accountLockout.body',
      params: {},
      resourceType: 'auth.account',
      resourceId: 'user-1',
      dedupeKey: 'lockout:user-1',
    });
  });

  it('still locks the account (login rejects as usual) even when the lockout notification emit REJECTS — best-effort', async () => {
    // A notification outage must NEVER change the lockout outcome: the user is locked and the login throws
    // the same generic InvalidCredentials. The swallowed emit error is logged, not propagated.
    (verify as jest.Mock).mockResolvedValue(false);
    const { service, prisma, notifications } = setup({ user: fullUser({ failedLoginCount: 4 }), emitThrows: true });

    await expect(service.login('admin@ftd.io', 'wrong')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    expect(prisma.user.update.mock.calls[0][0].data.lockedUntil).toBeInstanceOf(Date);
    expect(notifications.emit).toHaveBeenCalledTimes(1); // attempted, threw, was swallowed
  });

  it('rejects a non-ACTIVE user even with a correct password', async () => {
    const { service } = setup({ user: fullUser({ status: 'SUSPENDED' }) });

    await expect(service.login('admin@ftd.io', 'pw')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
  });

  it('treats an argon2 verify REJECT as a failed password (the `.catch(() => false)` arm) → InvalidCredentials + failure counted', async () => {
    // A corrupt stored passwordHash makes argon2 `verify` REJECT; the `.catch(() => false)` must fail
    // closed (treated as a wrong password), so the login is rejected generically and the attempt is
    // counted as a failure — never a 500 leaking the crypto error. Genuine error path, not padding.
    (verify as jest.Mock).mockRejectedValue(new Error('invalid argon2 hash'));
    const { service, prisma } = setup({ user: fullUser({ failedLoginCount: 0 }) });

    await expect(service.login('admin@ftd.io', 'pw')).rejects.toMatchObject({ response: { code: 'Auth.InvalidCredentials' } });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginCount: 1 }) }),
    );
  });

  it('issues a full session when MFA is off (the opt-in default)', async () => {
    const { service, prisma, challenges, jwt } = setup({ user: fullUser({ mfaEnabled: false }) });

    const outcome = await service.login('admin@ftd.io', 'pw');

    expect(outcome.status).toBe('authenticated');
    if (outcome.status !== 'authenticated') throw new Error('unreachable');
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
    expect(outcome.session.body.accessToken).toBe('access-jwt');
    expect(outcome.session.body.permissions).toEqual(['customers.read']);
    // F9: the access token embeds the user's current permission-snapshot version (pv) so PermissionsGuard
    // can reject it once an RBAC change bumps that version.
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1', permissions: ['customers.read'], pv: 5 }),
    );
    // The email is masked in the body, never returned raw.
    expect(outcome.session.body.user.email).not.toBe('admin@ftd.io');
  });

  it('records the attempt IP hash (never the raw IP) when a client IP is supplied', async () => {
    const { service, prisma } = setup({ user: fullUser({ mfaEnabled: false }) });

    await service.login('admin@ftd.io', 'pw', { ip: '203.0.113.7' });

    const attempt = prisma.loginAttempt.create.mock.calls[0][0];
    expect(attempt.data.success).toBe(true);
    expect(attempt.data.ipHash).toMatch(/^[0-9a-f]{64}$/); // sha-256 of the IP, not the raw IP
    expect(attempt.data.ipHash).not.toBe('203.0.113.7');
  });

  it('requires a second factor (no session yet) when MFA is confirmed', async () => {
    const { service, prisma, challenges } = setup({ user: fullUser({ mfaEnabled: true, mfaConfirmedAt: new Date() }) });

    const outcome = await service.login('admin@ftd.io', 'pw');

    expect(outcome.status).toBe('mfa_required');
    if (outcome.status !== 'mfa_required') throw new Error('unreachable');
    expect(outcome.challengeToken).toBe('challenge-token');
    expect(challenges.create).toHaveBeenCalled();
    // Crucially: NO session is minted until the second factor is presented.
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('uses the MFA config defaults (TTL 300 / maxAttempts 5) when those keys are unset', async () => {
    // config.get returns undefined for every key, so the `?? 300` and `?? 5` default arms are taken.
    const { service, challenges } = setup({
      user: fullUser({ mfaEnabled: true, mfaConfirmedAt: new Date() }),
      configGet: () => undefined,
    });

    const outcome = await service.login('admin@ftd.io', 'pw');

    expect(outcome.status).toBe('mfa_required');
    if (outcome.status !== 'mfa_required') throw new Error('unreachable');
    expect(outcome.challengeTtlSeconds).toBe(300); // default TTL
    expect(challenges.create).toHaveBeenCalledWith(expect.objectContaining({ ttlSeconds: 300, maxAttempts: 5 }));
  });

  it('ignores a presented remember-device token when the feature flag is UNSET (`?? false` default)', async () => {
    // A remember token is presented, but config.get(MFA_REMEMBER_DEVICE_ENABLED) → undefined ⇒ `?? false`,
    // so the trusted-device fast-path is skipped and the user still gets an MFA challenge.
    const { service, remembered, challenges } = setup({
      user: fullUser({ mfaEnabled: true, mfaConfirmedAt: new Date() }),
      configGet: () => undefined,
    });

    const outcome = await service.login('admin@ftd.io', 'pw', { rememberDeviceToken: 'device-tok' });

    expect(remembered.verify).not.toHaveBeenCalled(); // gate closed → token never even checked
    expect(challenges.create).toHaveBeenCalled();
    expect(outcome.status).toBe('mfa_required');
  });

  it('takes the trusted-device fast-path, skipping MFA, when a valid remember token is presented', async () => {
    const { service, challenges, remembered } = setup({
      user: fullUser({ mfaEnabled: true, mfaConfirmedAt: new Date() }),
      rememberEnabled: true,
      trusted: { userId: 'user-1' },
    });

    const outcome = await service.login('admin@ftd.io', 'pw', { rememberDeviceToken: 'device-tok' });

    expect(outcome.status).toBe('authenticated');
    expect(remembered.verify).toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
  });

  it('falls back to MFA when the remember token verifies but for a DIFFERENT user (no cross-user trust)', async () => {
    const { service, challenges } = setup({
      user: fullUser({ id: 'user-1', mfaEnabled: true, mfaConfirmedAt: new Date() }),
      rememberEnabled: true,
      trusted: { userId: 'someone-else' }, // valid token, wrong owner
    });

    const outcome = await service.login('admin@ftd.io', 'pw', { rememberDeviceToken: 'device-tok' });

    expect(outcome.status).toBe('mfa_required'); // the fast-path is NOT taken
    expect(challenges.create).toHaveBeenCalled();
  });
});

describe('AuthService.refresh', () => {
  it('rejects a malformed token with 401 and never queries the database', async () => {
    const { service, prisma } = setup();

    await expect(service.refresh('not-a-token')).rejects.toMatchObject({ response: { code: 'Auth.InvalidToken' } });
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a token with no `.` separator and a non-UUID id (parse guards) without a DB hit', async () => {
    const { service, prisma } = setup();
    await expect(service.refresh('rt_no-dot-here')).rejects.toMatchObject({ response: { code: 'Auth.InvalidToken' } });
    await expect(service.refresh('rt_not-a-uuid.secret')).rejects.toMatchObject({ response: { code: 'Auth.InvalidToken' } });
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('detects reuse of a revoked token and revokes every active session', async () => {
    const { service, prisma } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60_000), tokenHash: 'h' },
    });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toMatchObject({ response: { code: 'Auth.TokenReused' } });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
    );
  });

  it('rejects an expired token with 401', async () => {
    const { service } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() - 1000), tokenHash: 'h' },
    });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toMatchObject({ response: { code: 'Auth.InvalidToken' } });
  });

  it('rejects with 401 when the secret does not verify (argon verify rejects → caught → false)', async () => {
    (verify as jest.Mock).mockRejectedValue(new Error('bad hash')); // exercises the `.catch(() => false)` arm
    const { service } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), tokenHash: 'h' },
    });

    await expect(service.refresh(REFRESH_TOKEN)).rejects.toMatchObject({ response: { code: 'Auth.InvalidToken' } });
  });

  it('rotates the token atomically on a valid refresh', async () => {
    const { service, prisma } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), tokenHash: 'h' },
    });

    const result = await service.refresh(REFRESH_TOKEN);

    // Old revoked + new minted inside one $transaction; a fresh rt_ token is returned.
    expect(prisma.refreshToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ replacedById: expect.any(String) }) }),
    );
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.refreshToken.startsWith('rt_')).toBe(true);
    expect(result.body.accessToken).toBe('access-jwt');
  });
});

describe('AuthService.logout', () => {
  it('is a no-op for an unknown token', async () => {
    const { service, prisma } = setup({ refreshRow: null });

    await expect(service.logout(REFRESH_TOKEN)).resolves.toBeUndefined();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op (returns early) for a malformed token — never queries the DB', async () => {
    const { service, prisma } = setup();
    await expect(service.logout('not-a-token')).resolves.toBeUndefined();
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT revoke when the presented secret fails to verify (id alone must not revoke a family)', async () => {
    (verify as jest.Mock).mockResolvedValue(false); // wrong secret
    const { service, prisma } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), tokenHash: 'h' },
    });

    await service.logout(REFRESH_TOKEN);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT revoke when argon2 verify REJECTS on a corrupt stored hash (the `.catch(() => false)` arm)', async () => {
    // A corrupt tokenHash makes argon2 `verify` REJECT; logout's `.catch(() => false)` must fail closed
    // (no revoke), exactly like a wrong secret — a malformed row can never tear down a session family.
    (verify as jest.Mock).mockRejectedValue(new Error('invalid argon2 hash'));
    const { service, prisma } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), tokenHash: 'corrupt' },
    });

    await service.logout(REFRESH_TOKEN);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('revokes the whole session family for a valid token', async () => {
    const { service, prisma } = setup({
      refreshRow: { id: VALID_TOKEN_ID, userId: 'user-1', sessionId: 'sess-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000), tokenHash: 'h' },
    });

    await service.logout(REFRESH_TOKEN);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sessionId: 'sess-1', revokedAt: null }) }),
    );
  });
});

describe('AuthService.me', () => {
  it('returns a masked email and the resolved permission codes', async () => {
    const { service } = setup();

    const result = await service.me('user-1');

    expect(result.user.email).not.toBe('admin@ftd.io'); // masked
    expect(result.user.email).toContain('@');
    expect(result.permissions).toEqual(['customers.read']);
    expect(result.user.mfaEnabled).toBe(false);
  });

  it('returns no permissions when the user has no roles (the `rows?.userRoles ?? []` default arm)', async () => {
    // resolvePermissions' raw row is null → the optional-chaining default yields an empty permission set.
    const { service } = setup({ rolesRowOverride: null });

    const result = await service.me('user-1');
    expect(result.permissions).toEqual([]);
  });
});

describe('AuthService.issueSessionForUser', () => {
  it('mints a fresh session (refresh token + access JWT) for the MFA → full-session upgrade', async () => {
    const { service, prisma } = setup();

    const session = await service.issueSessionForUser('user-1');

    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(session.refreshToken.startsWith('rt_')).toBe(true);
    expect(session.body.accessToken).toBe('access-jwt');
  });
});

describe('refreshCookieOptions', () => {
  it('returns the hardened httpOnly cookie attributes scoped to the auth path', () => {
    const opts = refreshCookieOptions();
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
    expect(typeof opts.secure).toBe('boolean'); // gated to NODE_ENV=production
    expect(opts.maxAge).toBeGreaterThan(0); // mirrors the refresh-token TTL in seconds
    expect(REFRESH_COOKIE_NAME).toBe('ftd_refresh');
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
  });
});
