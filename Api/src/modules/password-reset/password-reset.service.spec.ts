/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for PasswordResetService (the combined verify was split into verify-code +
 * verify). Every collaborator is mocked; argon2id runs for real so the decoy-hash /
 * same-password / strong-password paths are exercised. Covers:
 *   initiate  — NO-ENUMERATION + constant-time (eligible / absent / non-MFA / inactive; always ONE audit row).
 *   verifyCode — Step 2: TOTP success (replay floor advanced, factor STAMPED, verify_code SUCCESS audit,
 *     NO consume), backup-code success, bad factor (attempt counted, FAIL audit, 401, NOT stamped),
 *     fingerprint mismatch, user gone, TOTP without an enrolled secret, lost markFactorVerified race (401),
 *     and the IDEMPOTENT short-circuit on an already-stamped challenge (factor NOT re-spent — B2 defense).
 *   verify    — Step 3 (password-only): success (consume + revoke-all + complete audit, NO session), the
 *     factor-required gate (401 Auth.ResetFactorRequired when not stamped), weak/same password (400, not
 *     consumed), fingerprint mismatch on the password call, lost consume race (401), user gone; plus the
 *     A15 completion hook (a linked admin-approval request is stamped completedAt + audited; ordinary
 *     resets are a strict no-op).
 *   adminReset — admin fallback + the recipient-scoped admin-password-reset SECURITY_ALERT
 *     to the TARGET (best-effort; a thrown emit does NOT fail the reset).
 */
// otplib/qrcode are ESM-first; mock them so importing TotpService doesn't load otplib under Jest.
jest.mock("otplib", () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verify: jest.fn(),
}));
jest.mock("qrcode", () => ({ toDataURL: jest.fn() }));

import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import type { AuditService } from "../../common/audit/audit.service";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { BackupCodeService } from "../mfa/backup-code.service";
import type { TotpService } from "../mfa/totp.service";
import type { NotificationService } from "../notification/notification.service";
import type {
  OpenResetChallenge,
  PasswordResetChallengeService,
} from "./password-reset-challenge.service";
import { PasswordResetService } from "./password-reset.service";

const STRONG = "Aa1!aaaaaaaa"; // 12 chars, upper+lower+digit+symbol
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** A still-open challenge whose 2nd factor has NOT yet been verified (verify-code input). */
const OPEN: OpenResetChallenge = {
  id: "c1",
  userId: "u1",
  purpose: "PASSWORD_RESET",
  attemptCount: 0,
  maxAttempts: 5,
  createdIpHash: null,
  uaHash: null,
  factorVerifiedAt: null,
  factorMethod: null,
};

/** A challenge whose 2nd factor was already proven at verify-code — the gate the new verify() requires. */
const OPEN_VERIFIED: OpenResetChallenge = {
  ...OPEN,
  factorVerifiedAt: new Date(),
  factorMethod: "totp",
};

function makeTxClient() {
  return {
    user: { update: jest.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    rememberedDevice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mfaChallenge: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    passwordResetChallenge: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function setup() {
  const tx = makeTxClient();
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    // A15 completion hook: the default (no linked admin-approval request) is the null/no-op path.
    passwordResetRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (cb: (c: typeof tx) => Promise<boolean>) =>
      cb(tx),
    ),
  };
  const totp = {
    decryptSecret: jest.fn().mockResolvedValue("SECRET"),
    verify: jest.fn(),
  };
  const backupCodes = { verify: jest.fn() };
  const challenges = {
    create: jest
      .fn()
      .mockResolvedValue({
        token: "pwr_id.secret",
        challengeId: "c1",
        expiresAt: new Date(),
      }),
    consume: jest.fn().mockResolvedValue(true),
    registerFailedAttempt: jest.fn().mockResolvedValue(undefined),
    markFactorVerified: jest.fn().mockResolvedValue(true),
  };
  const config = { get: jest.fn(() => undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    emit: jest.fn().mockResolvedValue({ id: "n1", deduped: false }),
  };
  const svc = new PasswordResetService(
    prisma as unknown as PrismaService,
    totp as unknown as TotpService,
    backupCodes as unknown as BackupCodeService,
    challenges as unknown as PasswordResetChallengeService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    notifications as unknown as NotificationService,
  );
  return {
    svc,
    prisma,
    tx,
    totp,
    backupCodes,
    challenges,
    config,
    audit,
    notifications,
  };
}

describe("PasswordResetService.initiate (no-enumeration + constant-time)", () => {
  it("#1 eligible (active, MFA-confirmed) user: mints a challenge token + audits ONE eligible row", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      mfaEnabled: true,
      mfaConfirmedAt: new Date(),
      status: "ACTIVE",
    });
    const res = await m.svc.initiate("op@example.com", { ip: "1.2.3.4" });
    expect(res.challengeToken).toBe("pwr_id.secret");
    expect(m.challenges.create).toHaveBeenCalledTimes(1);
    expect(m.audit.record).toHaveBeenCalledTimes(1);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.initiate",
        outcome: "SUCCESS",
        context: expect.objectContaining({ eligible: true }),
      }),
    );
    const ctx = m.audit.record.mock.calls[0][0].context as { email: string };
    expect(ctx.email).not.toBe("op@example.com");
    expect(ctx.email).toContain("***");
  });

  it("#2 absent user: NO token, a decoy hash runs, and exactly ONE audit row (eligible:false)", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue(null);
    const res = await m.svc.initiate("ghost@example.com", { ip: "1.2.3.4" });
    // A DECOY token is returned (Set-Cookie stays uniform) but NO real challenge is minted.
    expect(res.challengeToken).toMatch(/^pwr_/);
    expect(m.challenges.create).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledTimes(1);
    // A system-originated event for an absent subject audits with actorUserId NULL (no
    // FK violation, no 409) — replacing the old SYSTEM_ACTOR placeholder that broke on a fresh DB.
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        context: expect.objectContaining({ eligible: false }),
      }),
    );
  });

  it("#3 user without confirmed MFA: NO token (MFA-enabled state never leaks), ONE audit row", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      mfaEnabled: false,
      mfaConfirmedAt: null,
      status: "ACTIVE",
    });
    const res = await m.svc.initiate("nomfa@example.com", {});
    expect(res.challengeToken).toMatch(/^pwr_/); // decoy
    expect(m.challenges.create).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledTimes(1);
  });

  it("#4 inactive (suspended) but MFA-confirmed user is NOT eligible", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      mfaEnabled: true,
      mfaConfirmedAt: new Date(),
      status: "SUSPENDED",
    });
    const res = await m.svc.initiate("locked@example.com", {});
    expect(res.challengeToken).toMatch(/^pwr_/); // decoy
    expect(m.challenges.create).not.toHaveBeenCalled();
  });

  it("#5 eligible + ineligible both return a pwr_-shaped token — Set-Cookie uniform (no enumeration)", async () => {
    const eligibleM = setup();
    eligibleM.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      mfaEnabled: true,
      mfaConfirmedAt: new Date(),
      status: "ACTIVE",
    });
    const eligibleRes = await eligibleM.svc.initiate("op@example.com", {});
    const ghostM = setup();
    ghostM.prisma.user.findUnique.mockResolvedValue(null);
    const ghostRes = await ghostM.svc.initiate("ghost@example.com", {});
    // Both branches yield a same-shaped opaque token, so the Set-Cookie header cannot distinguish an
    // active MFA-enrolled account from any other email — only the eligible branch mints a real challenge.
    expect(eligibleRes.challengeToken).toMatch(/^pwr_.+\..+/);
    expect(ghostRes.challengeToken).toMatch(/^pwr_.+\..+/);
    // The real decoy (from production code, not a mock) is a well-formed pwr_<uuid>.<secret>.
    expect(ghostRes.challengeToken).toMatch(
      /^pwr_[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/,
    );
    expect(eligibleM.challenges.create).toHaveBeenCalledTimes(1);
    expect(ghostM.challenges.create).not.toHaveBeenCalled();
  });
});

describe("PasswordResetService.verifyCode (Step 2 — factor only, stamps the challenge)", () => {
  function withFactorUser(
    m: ReturnType<typeof setup>,
    over: Record<string, unknown> = {},
  ) {
    m.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      totpSecretEnc: "enc",
      lastUsedTotpStep: null,
      ...over,
    });
  }

  it("#VC1 valid TOTP: advances the replay floor, stamps the factor (totp), audits verify_code SUCCESS, NO consume", async () => {
    const m = setup();
    withFactorUser(m);
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 42 });
    const res = await m.svc.verifyCode(OPEN, "123456", { ip: "1.2.3.4" });
    expect(res).toEqual({ status: "code_verified" });
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { lastUsedTotpStep: 42 },
    });
    expect(m.challenges.markFactorVerified).toHaveBeenCalledWith("c1", "totp");
    expect(m.challenges.consume).not.toHaveBeenCalled();
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.verify_code",
        outcome: "SUCCESS",
        context: { method: "totp" },
      }),
    );
  });

  it("#VC2 valid backup code: consumes the code, stamps the factor (backup_code), audits SUCCESS", async () => {
    const m = setup();
    withFactorUser(m);
    m.backupCodes.verify.mockResolvedValue(true);
    const res = await m.svc.verifyCode(OPEN, "A1B2C-D3E4F", {});
    expect(res).toEqual({ status: "code_verified" });
    expect(m.backupCodes.verify).toHaveBeenCalledWith("u1", "A1B2C-D3E4F");
    expect(m.challenges.markFactorVerified).toHaveBeenCalledWith(
      "c1",
      "backup_code",
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.verify_code",
        context: { method: "backup_code" },
      }),
    );
  });

  it("#VC3 bad factor: attempt counted, FAIL audited, 401 Auth.ResetInvalidCode, NOT stamped", async () => {
    const m = setup();
    withFactorUser(m);
    m.totp.verify.mockResolvedValue({ ok: false });
    await expect(
      m.svc.verifyCode(OPEN, "000000", { ip: "9.9.9.9" }),
    ).rejects.toMatchObject({ response: { code: "Auth.ResetInvalidCode" } });
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.challenges.markFactorVerified).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.verify",
        outcome: "FAIL",
        context: { reason: "invalid_code" },
      }),
    );
  });

  it("#VC4 fingerprint mismatch: reject without touching the factor (no totp/backup, no user lookup)", async () => {
    const m = setup();
    const bound: OpenResetChallenge = {
      ...OPEN,
      createdIpHash: sha256("1.1.1.1"),
      uaHash: sha256("ua-a"),
    };
    await expect(
      m.svc.verifyCode(bound, "123456", { ip: "2.2.2.2", userAgent: "ua-b" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.totp.verify).not.toHaveBeenCalled();
    expect(m.backupCodes.verify).not.toHaveBeenCalled();
    expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(m.challenges.markFactorVerified).not.toHaveBeenCalled();
  });

  it("#VC4b UA-bound challenge: a UA mismatch (same IP) is rejected (ua fingerprint enforced at verify-code)", async () => {
    const m = setup();
    const bound: OpenResetChallenge = {
      ...OPEN,
      createdIpHash: null,
      uaHash: sha256("ua-trusted"),
    };
    await expect(
      m.svc.verifyCode(bound, "123456", {
        ip: "7.7.7.7",
        userAgent: "ua-evil",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.totp.verify).not.toHaveBeenCalled();
  });

  it("#VC5 challenge whose user no longer exists: reject (defensive 401, attempt counted, not stamped)", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue(null);
    await expect(m.svc.verifyCode(OPEN, "123456", {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.challenges.markFactorVerified).not.toHaveBeenCalled();
  });

  it("#VC6 TOTP with no enrolled secret: bad factor (no decrypt, 401, not stamped)", async () => {
    const m = setup();
    withFactorUser(m, { totpSecretEnc: null });
    await expect(m.svc.verifyCode(OPEN, "123456", {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(m.totp.decryptSecret).not.toHaveBeenCalled();
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalled();
    expect(m.challenges.markFactorVerified).not.toHaveBeenCalled();
  });

  it("#VC7 lost markFactorVerified race (returns false) -> 401 Auth.ResetChallengeConsumed", async () => {
    const m = setup();
    withFactorUser(m);
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 1 });
    m.challenges.markFactorVerified.mockResolvedValue(false);
    await expect(m.svc.verifyCode(OPEN, "123456", {})).rejects.toMatchObject({
      response: { code: "Auth.ResetChallengeConsumed" },
    });
  });

  it("#VC8 IDEMPOTENT: an already-stamped challenge returns code_verified WITHOUT re-spending the factor (B2)", async () => {
    const m = setup();
    const res = await m.svc.verifyCode(OPEN_VERIFIED, "123456", {});
    expect(res).toEqual({ status: "code_verified" });
    // The factor is NOT re-run: no user lookup, no TOTP/backup, no floor advance, no re-stamp, no attempt spent.
    expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(m.totp.verify).not.toHaveBeenCalled();
    expect(m.backupCodes.verify).not.toHaveBeenCalled();
    expect(m.prisma.user.update).not.toHaveBeenCalled();
    expect(m.challenges.markFactorVerified).not.toHaveBeenCalled();
    expect(m.challenges.registerFailedAttempt).not.toHaveBeenCalled();
  });

  it("#VC9 matching fingerprint passes the bind check and proceeds to the factor", async () => {
    const m = setup();
    const bound: OpenResetChallenge = {
      ...OPEN,
      createdIpHash: sha256("5.5.5.5"),
      uaHash: sha256("ua-z"),
    };
    m.prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      totpSecretEnc: "enc",
      lastUsedTotpStep: null,
    });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 7 });
    await m.svc.verifyCode(bound, "123456", {
      ip: "5.5.5.5",
      userAgent: "ua-z",
    });
    expect(m.challenges.markFactorVerified).toHaveBeenCalledWith("c1", "totp");
  });
});

describe("PasswordResetService.verify (Step 3 — password only, gated on the factor stamp)", () => {
  function withUser(m: ReturnType<typeof setup>, passwordHash: string) {
    m.prisma.user.findUnique.mockResolvedValue({ id: "u1", passwordHash });
  }
  const CURRENT_HASH =
    "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3hQ0m0n7qjQh0m0n7qjQh0m0n7qjQh0m0n7qjQh0m0";

  it("#V1 factor stamped + strong differing password: consume, revoke ALL, audit SUCCESS with the stamped method, NO session", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash("Different-Current-1!"));
    await m.svc.verify(OPEN_VERIFIED, STRONG, { ip: "1.2.3.4" });
    expect(m.challenges.consume).toHaveBeenCalledWith("c1", m.tx);
    expect(m.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" },
        data: expect.objectContaining({
          failedLoginCount: 0,
          lockedUntil: null,
        }),
      }),
    );
    const data = m.tx.user.update.mock.calls[0][0].data as {
      passwordHash: string;
    };
    expect(data.passwordHash).toMatch(/^\$argon2/);
    expect(data.passwordHash).not.toContain(STRONG);
    expect(m.tx.refreshToken.updateMany).toHaveBeenCalled();
    expect(m.tx.rememberedDevice.updateMany).toHaveBeenCalled();
    expect(m.tx.mfaChallenge.updateMany).toHaveBeenCalled();
    expect(m.tx.passwordResetChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "c1" } }),
      }),
    );
    // The audited method is read off the stamped challenge, not a per-call code.
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.complete",
        outcome: "SUCCESS",
        context: { method: "totp" },
      }),
    );
  });

  it("#V1b backup-stamped challenge audits complete with method backup_code (read off the challenge)", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash("Different-Current-1!"));
    const backupStamped: OpenResetChallenge = {
      ...OPEN,
      factorVerifiedAt: new Date(),
      factorMethod: "backup_code",
    };
    await m.svc.verify(backupStamped, STRONG, {});
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ context: { method: "backup_code" } }),
    );
  });

  it("#V1c (A15) ordinary reset — NO linked request: completedAt is never touched, no complete audit", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash("Different-Current-1!"));
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue(null); // no admin-approval lineage
    await m.svc.verify(OPEN_VERIFIED, STRONG, {});
    // The lookup is scoped to THIS challenge's unclaimed request…
    expect(m.prisma.passwordResetRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { challengeId: "c1", completedAt: null },
      }),
    );
    // …and with none found, nothing is stamped and only the ONE reset.complete audit row exists.
    expect(m.prisma.passwordResetRequest.updateMany).not.toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalledTimes(1);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "password.reset.complete" }),
    );
  });

  it("#V1d (A15) admin-approval reset — linked request: completedAt stamped + reset_request.complete audited", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash("Different-Current-1!"));
    m.prisma.passwordResetRequest.findFirst.mockResolvedValue({ id: "req-1" });
    const adminStamped: OpenResetChallenge = {
      ...OPEN,
      factorVerifiedAt: new Date(),
      factorMethod: "admin_approval",
    };
    await m.svc.verify(adminStamped, STRONG, { ip: "1.2.3.4" });
    // The request is stamped completed (guarded on completedAt still null — set-once).
    expect(m.prisma.passwordResetRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", completedAt: null },
      data: { completedAt: expect.any(Date) },
    });
    // BOTH audit rows: the standard reset.complete (method read off the challenge) + the request completion.
    expect(m.audit.record).toHaveBeenCalledTimes(2);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset.complete",
        context: { method: "admin_approval" },
      }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.reset_request.complete",
        resourceType: "auth.password_reset_request",
        resourceId: "req-1",
        outcome: "SUCCESS",
        context: {},
      }),
    );
  });

  it("#V2 factor NOT stamped -> 401 Auth.ResetFactorRequired BEFORE any user lookup/consume/tx", async () => {
    const m = setup();
    await expect(m.svc.verify(OPEN, STRONG, {})).rejects.toMatchObject({
      response: { code: "Auth.ResetFactorRequired" },
    });
    await expect(m.svc.verify(OPEN, STRONG, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(m.challenges.consume).not.toHaveBeenCalled();
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#V3 weak new password (factor stamped) -> 400 Auth.WeakPassword, NOT consumed", async () => {
    const m = setup();
    withUser(m, CURRENT_HASH);
    await expect(
      m.svc.verify(OPEN_VERIFIED, "short1!A", {}),
    ).rejects.toMatchObject({ response: { code: "Auth.WeakPassword" } });
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });

  it("#V4 new password equal to the current one (factor stamped) -> 400 Auth.SamePassword, NOT consumed", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash(STRONG)); // current hash matches the proposed new password
    await expect(m.svc.verify(OPEN_VERIFIED, STRONG, {})).rejects.toMatchObject(
      { response: { code: "Auth.SamePassword" } },
    );
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });

  it("#V5 fingerprint mismatch on the password call -> reject 401 (attempt counted, no consume)", async () => {
    const m = setup();
    const boundVerified: OpenResetChallenge = {
      ...OPEN_VERIFIED,
      createdIpHash: sha256("1.1.1.1"),
      uaHash: sha256("ua-a"),
    };
    await expect(
      m.svc.verify(boundVerified, STRONG, { ip: "2.2.2.2", userAgent: "ua-b" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });

  it("#V6 lost single-use race (consume -> false) -> 401 Auth.ResetChallengeConsumed", async () => {
    const m = setup();
    const { hash } = await import("@node-rs/argon2");
    withUser(m, await hash("Different-Current-1!"));
    m.challenges.consume.mockResolvedValue(false);
    await expect(m.svc.verify(OPEN_VERIFIED, STRONG, {})).rejects.toMatchObject(
      { response: { code: "Auth.ResetChallengeConsumed" } },
    );
  });

  it("#V7 challenge whose user no longer exists (factor stamped) -> reject 401 (attempt counted)", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      m.svc.verify(OPEN_VERIFIED, STRONG, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.challenges.registerFailedAttempt).toHaveBeenCalledWith("c1");
    expect(m.challenges.consume).not.toHaveBeenCalled();
  });
});

describe("PasswordResetService.adminReset (admin fallback)", () => {
  it("#A1 self-reset (actor === target) -> 403 Auth.SelfResetForbidden, checked BEFORE any lookup/tx", async () => {
    const m = setup();
    await expect(
      m.svc.adminReset("admin-1", "admin-1", STRONG),
    ).rejects.toMatchObject({ response: { code: "Auth.SelfResetForbidden" } });
    await expect(
      m.svc.adminReset("admin-1", "admin-1", STRONG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#A2 target not found -> 404 Auth.UserNotFound, no tx entered", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      m.svc.adminReset("admin-1", "ghost", STRONG),
    ).rejects.toMatchObject({ response: { code: "Auth.UserNotFound" } });
    await expect(
      m.svc.adminReset("admin-1", "ghost", STRONG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#A3 weak password -> 400 Auth.WeakPassword AND the $transaction is NOT entered (no user.update)", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: "target-1" });
    await expect(
      m.svc.adminReset("admin-1", "target-1", "short1!A"),
    ).rejects.toMatchObject({ response: { code: "Auth.WeakPassword" } });
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.tx.user.update).not.toHaveBeenCalled();
  });

  it("#A4 happy path: sets a fresh argon2id hash + clears lock state, revokes ALL target trust in ONE tx, NO token", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: "target-1" });
    await m.svc.adminReset("admin-1", "target-1", STRONG);
    expect(m.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "target-1" },
        data: expect.objectContaining({
          failedLoginCount: 0,
          lockedUntil: null,
        }),
      }),
    );
    const data = m.tx.user.update.mock.calls[0][0].data as {
      passwordHash: string;
    };
    expect(data.passwordHash).toMatch(/^\$argon2/);
    expect(data.passwordHash).not.toContain(STRONG);
    expect(m.tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "target-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(m.tx.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: "target-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(m.tx.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: { userId: "target-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(m.tx.passwordResetChallenge.updateMany).toHaveBeenCalledWith({
      where: { userId: "target-1", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(
      m.tx.passwordResetChallenge.updateMany.mock.calls[0][0].where,
    ).not.toHaveProperty("id");
    expect(m.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("#A5 audits password.admin_reset SUCCESS with actor + target and NO password in context", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: "target-1" });
    await m.svc.adminReset("admin-1", "target-1", STRONG);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin-1",
        action: "password.admin_reset",
        resourceId: "target-1",
        outcome: "SUCCESS",
        context: { targetUserId: "target-1" },
      }),
    );
    const serialized = JSON.stringify(m.audit.record.mock.calls[0][0]);
    expect(serialized).not.toContain(STRONG);
  });

  it("#A6 emits ONE recipient-scoped SECURITY_ALERT to the TARGET (not the actor), PII-free, after the audit", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: "target-1" });
    await m.svc.adminReset("admin-1", "target-1", STRONG);
    expect(m.notifications.emit).toHaveBeenCalledTimes(1);
    expect(m.notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "target-1",
        type: "SECURITY_ALERT",
        severity: "critical",
        titleKey: "notifications.security.adminPasswordReset.title",
        bodyKey: "notifications.security.adminPasswordReset.body",
        params: {},
        resourceType: "user",
        resourceId: "target-1",
      }),
    );
    // Recipient is the TARGET, never the acting admin; params carry no PII (and the new password never leaks).
    const arg = m.notifications.emit.mock.calls[0][0];
    expect(arg.recipientUserId).toBe("target-1");
    expect(arg.recipientUserId).not.toBe("admin-1");
    expect(JSON.stringify(arg.params)).toBe("{}");
    expect(JSON.stringify(arg)).not.toContain(STRONG);
  });

  it("#A7 best-effort: a thrown emit does NOT fail the reset (already committed + audited)", async () => {
    const m = setup();
    m.prisma.user.findUnique.mockResolvedValue({ id: "target-1" });
    m.notifications.emit.mockRejectedValue(
      new Error("notification backend down"),
    );
    await expect(
      m.svc.adminReset("admin-1", "target-1", STRONG),
    ).resolves.toBeUndefined();
    // The reset + audit still happened; only the side-effect notification was swallowed.
    expect(m.tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "target-1" } }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.admin_reset",
        outcome: "SUCCESS",
      }),
    );
  });
});
