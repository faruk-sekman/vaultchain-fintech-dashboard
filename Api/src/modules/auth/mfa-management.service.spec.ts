/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaManagementService. Collaborators mocked; argon2id runs for real.
 * Covers: disable (password + TOTP → clears MFA, deletes codes, revokes devices), not-enrolled (400),
 * wrong password / wrong factor (401, nothing cleared), backup-code as the second factor, backup-code
 * regeneration, the administrator reset (clears target MFA + revokes sessions/devices/challenges), and
 * the recipient-scoped admin-MFA-reset SECURITY_ALERT notification to the TARGET (best-effort; a thrown
 * emit does NOT fail the reset).
 */
jest.mock("otplib", () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verify: jest.fn(),
}));
jest.mock("qrcode", () => ({ toDataURL: jest.fn() }));

import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { ConfigService } from "@nestjs/config";
import type { AuditService } from "../../common/audit/audit.service";
import type { PrismaService } from "../../infrastructure/prisma/prisma.service";
import type { BackupCodeService } from "../mfa/backup-code.service";
import type { RememberedDeviceService } from "../mfa/remembered-device.service";
import type { TotpService } from "../mfa/totp.service";
import type { NotificationService } from "../notification/notification.service";
import type { ModuleRef } from "@nestjs/core";
import { MfaManagementService } from "./mfa-management.service";

const PASSWORD = "correct-horse-battery";
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await hash(PASSWORD);
});

const enrolled = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  passwordHash: PASSWORD_HASH,
  totpSecretEnc: "enc",
  lastUsedTotpStep: null,
  mfaEnabled: true,
  mfaConfirmedAt: new Date(),
  ...over,
});

function setup(user: Record<string, unknown>) {
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({}),
    },
    backupCode: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    rememberedDevice: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mfaChallenge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const totp = {
    decryptSecret: jest.fn().mockResolvedValue("SECRET"),
    verify: jest.fn().mockResolvedValue({ ok: true, usedStep: 5 }),
  };
  const backupCodes = {
    verify: jest.fn().mockResolvedValue(true),
    generate: jest.fn().mockResolvedValue(["A1B2C-D3E4F", "G5H6J-K7M8N"]),
  };
  const remembered = {
    revokeForUser: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(undefined),
    revokeByToken: jest.fn().mockResolvedValue(undefined),
    listActiveForUser: jest.fn().mockResolvedValue([
      {
        id: "d1",
        createdAt: new Date(),
        expiresAt: new Date(),
        ipPrefix: "203.0.113.0/24",
      },
    ]),
  };
  const config = { get: jest.fn().mockReturnValue(10) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const notifications = {
    emit: jest.fn().mockResolvedValue({ id: "n1", deduped: false }),
  };
  // adminReset() pulls NotificationService lazily via ModuleRef.get(); the stub returns the same mock so
  // the existing m.notifications.emit assertions hold.
  const moduleRef = {
    get: jest
      .fn()
      .mockReturnValue(notifications as unknown as NotificationService),
  };
  const svc = new MfaManagementService(
    prisma as unknown as PrismaService,
    totp as unknown as TotpService,
    backupCodes as unknown as BackupCodeService,
    remembered as unknown as RememberedDeviceService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    moduleRef as unknown as ModuleRef,
  );
  return {
    svc,
    prisma,
    totp,
    backupCodes,
    remembered,
    config,
    audit,
    notifications,
    moduleRef,
  };
}

const CLEAR = {
  mfaEnabled: false,
  mfaConfirmedAt: null,
  totpSecretEnc: null,
  lastUsedTotpStep: null,
};

describe("MfaManagementService.disable", () => {
  it("#1 password + TOTP → clears MFA, deletes backup codes, revokes devices, audits", async () => {
    const m = setup(enrolled());
    await m.svc.disable("u1", PASSWORD, "123456");
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: CLEAR,
    });
    expect(m.prisma.backupCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(m.prisma.rememberedDevice.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa.disable", outcome: "SUCCESS" }),
    );
  });

  it("#2 not enrolled → 400", async () => {
    const m = setup(enrolled({ mfaEnabled: false, mfaConfirmedAt: null }));
    await expect(
      m.svc.disable("u1", PASSWORD, "123456"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("#3 wrong password → 401 and nothing is cleared", async () => {
    const m = setup(enrolled());
    await expect(
      m.svc.disable("u1", "wrong-password", "123456"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#3a a malformed stored hash makes argon2 THROW → caught as a failed verify → 401 (never leaks)", async () => {
    // argonVerify rejects on an un-parseable hash; assertPassword's `.catch(() => false)` swallows it
    // into a plain 401 rather than surfacing the crypto error. Nothing is cleared.
    const m = setup(enrolled({ passwordHash: "not-a-valid-argon2-hash" }));
    await expect(
      m.svc.disable("u1", PASSWORD, "123456"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#4 wrong second factor → 401 and nothing is cleared", async () => {
    const m = setup(enrolled());
    m.totp.verify.mockResolvedValue({ ok: false });
    await expect(
      m.svc.disable("u1", PASSWORD, "000000"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#5 a backup code (non-6-digit) is checked via BackupCodeService, not TOTP", async () => {
    const m = setup(enrolled());
    await m.svc.disable("u1", PASSWORD, "A1B2C-D3E4F");
    expect(m.backupCodes.verify).toHaveBeenCalledWith("u1", "A1B2C-D3E4F");
    expect(m.totp.verify).not.toHaveBeenCalled();
  });
});

describe("MfaManagementService.regenerateBackupCodes", () => {
  it("#6 returns a fresh set and audits", async () => {
    const m = setup(enrolled());
    const res = await m.svc.regenerateBackupCodes("u1", PASSWORD, "123456");
    expect(res.backupCodes).toHaveLength(2);
    expect(m.backupCodes.generate).toHaveBeenCalledWith("u1", 10);
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mfa.backup_codes.regenerate" }),
    );
  });

  it("#6a falls back to a count of 10 when MFA_BACKUP_CODE_COUNT is unset", async () => {
    const m = setup(enrolled());
    m.config.get.mockReturnValue(undefined); // config miss → `?? 10` fallback
    await m.svc.regenerateBackupCodes("u1", PASSWORD, "123456");
    expect(m.backupCodes.generate).toHaveBeenCalledWith("u1", 10);
  });
});

describe("MfaManagementService.adminReset", () => {
  it("#7 clears the target MFA + revokes sessions/devices/challenges, audits actor + target", async () => {
    const m = setup({ id: "target" });
    await m.svc.adminReset("admin-1", "target");
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "target" },
      data: CLEAR,
    });
    expect(m.prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "target", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(m.prisma.mfaChallenge.updateMany).toHaveBeenCalledWith({
      where: { userId: "target", consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mfa.admin_reset",
        actorUserId: "admin-1",
        resourceId: "target",
      }),
    );
  });

  it("#8 self-reset via the admin path is FORBIDDEN (must use /disable) — nothing is cleared", async () => {
    const m = setup({ id: "admin-1" });
    await expect(m.svc.adminReset("admin-1", "admin-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("#8a emits ONE recipient-scoped SECURITY_ALERT to the TARGET (not the actor), PII-free, after the audit", async () => {
    const m = setup({ id: "target" });
    await m.svc.adminReset("admin-1", "target");
    expect(m.notifications.emit).toHaveBeenCalledTimes(1);
    expect(m.notifications.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "target",
        type: "SECURITY_ALERT",
        severity: "warning",
        titleKey: "notifications.security.adminMfaReset.title",
        bodyKey: "notifications.security.adminMfaReset.body",
        params: {},
        resourceType: "user",
        resourceId: "target",
      }),
    );
    // Recipient is the TARGET, never the acting admin; params carry no PII.
    const arg = m.notifications.emit.mock.calls[0][0];
    expect(arg.recipientUserId).toBe("target");
    expect(arg.recipientUserId).not.toBe("admin-1");
    expect(JSON.stringify(arg.params)).toBe("{}");
  });

  it("#8b best-effort: a thrown emit does NOT fail the MFA reset (already committed + audited)", async () => {
    const m = setup({ id: "target" });
    m.notifications.emit.mockRejectedValue(
      new Error("notification backend down"),
    );
    await expect(
      m.svc.adminReset("admin-1", "target"),
    ).resolves.toBeUndefined();
    // The reset + audit still happened; only the side-effect notification was swallowed.
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: "target" },
      data: CLEAR,
    });
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mfa.admin_reset",
        outcome: "SUCCESS",
      }),
    );
  });

  it("#8c a NON-Error emit rejection is also swallowed (generic 'unknown error' in the warn)", async () => {
    const m = setup({ id: "target" });
    m.notifications.emit.mockRejectedValue("notification backend string reject"); // non-Error
    const warn = jest
      .spyOn(
        (m.svc as unknown as { logger: { warn: (msg: string) => void } }).logger,
        "warn",
      )
      .mockImplementation(() => undefined);

    // The reset must still resolve; the non-Error message collapses to the generic branch.
    await expect(
      m.svc.adminReset("admin-1", "target"),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("unknown error");
    warn.mockRestore();
  });
});

describe("MfaManagementService trusted devices", () => {
  it("#9 listDevices returns the operator's active remembered devices", async () => {
    const m = setup({ id: "u1" });
    const devices = await m.svc.listDevices("u1");
    expect(devices).toHaveLength(1);
    expect(m.remembered.listActiveForUser).toHaveBeenCalledWith("u1");
  });

  it("#10 revokeDevice scopes to the owner and audits", async () => {
    const m = setup({ id: "u1" });
    await m.svc.revokeDevice("u1", "d1");
    expect(m.remembered.revokeForUser).toHaveBeenCalledWith("u1", "d1");
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mfa.device.revoke",
        resourceId: "d1",
      }),
    );
  });
});
