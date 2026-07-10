/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Password-reset service. A SELF-CONTAINED, MFA-second-factor-gated
 * "I forgot my password" flow for MFA-enrolled operators — NO email, NO JWT, NO new dependency. Two
 * use-cases:
 *
 *  initiate(email) — NO-ENUMERATION + CONSTANT-TIME. Always responds the same and always writes exactly
 *    one audit row (masked email only). The same argon2id work runs whether or not the user exists / is
 *    MFA-enrolled (a decoy hash on the absent branch equalizes timing). A reset challenge + the
 *    `ftd_pwreset` cookie are minted ONLY when the user exists AND has confirmed MFA — but the response
 *    body/status/headers (other than the conditional Set-Cookie) are byte-identical on both branches,
 *    so MFA-enabled state never leaks.
 *
 *  verify(challenge, code, newPassword) — enforce the stored IP/UA fingerprint, check the second factor
 *    (TOTP against its replay floor, or a one-time backup code), validate the new password, then in ONE
 *    transaction: consume the single-use challenge, set the new argon2id hash + clear lock state, and
 *    REVOKE ALL of the user's refresh tokens, remembered devices, live MFA challenges, and other open
 *    reset challenges. NO session is issued — the operator must sign in fresh.
 *
 * Brute force on the factor is bounded per-challenge (attempt counter); THE VICTIM ACCOUNT IS NEVER
 * LOCKED by reset attempts. Codes, secrets, tokens and raw emails never reach logs or the audit context (the request body is never written to logs).
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import type { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { maskEmail } from "../../common/util/mask";
import { uuidv7 } from "../../common/util/uuid";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { BackupCodeService } from "../mfa/backup-code.service";
import { TotpService } from "../mfa/totp.service";
import { NotificationService } from "../notification/notification.service";
import {
  PWRESET_CHALLENGE_TOKEN_PREFIX,
  PWRESET_CHALLENGE_TTL_DEFAULT,
  PWRESET_MAX_ATTEMPTS_DEFAULT,
  PWRESET_PASSWORD_MAX_LENGTH,
  PWRESET_PASSWORD_MIN_LENGTH,
  PasswordResetPurpose,
} from "./password-reset.constants";
import {
  OpenResetChallenge,
  PasswordResetChallengeService,
} from "./password-reset-challenge.service";

type ResetMethod = "totp" | "backup_code";

/** Request context for binding/auditing — all optional (absent = no signal). */
export interface ResetContext {
  ip?: string;
  userAgent?: string;
}

/** What the controller needs to finish the initiate response: the cookie value + its TTL. */
export interface InitiateResult {
  /**
   * The opaque `pwr_<id>.<secret>` token to set as the `ftd_pwreset` cookie. ALWAYS present
   * — a REAL challenge for an eligible MFA-enrolled user, else a structurally-valid DECOY
   * that references no DB row (loadOpen fail-closes on it). Setting it on BOTH branches keeps the
   * Set-Cookie header uniform so its presence never reveals MFA-enrollment.
   */
  challengeToken: string;
  challengeTtlSeconds: number;
}

/** A precomputed, clearly-labeled decoy argon2id hash used to equalize timing on the absent/non-MFA branch. */
const DECOY_PASSWORD = "ftd-password-reset-decoy-not-a-secret";

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
    private readonly backupCodes: BackupCodeService,
    private readonly challenges: PasswordResetChallengeService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Start a reset. ALWAYS does the same observable work and ALWAYS writes exactly one audit row
   * (masked email). A challenge + cookie are minted ONLY for an existing, MFA-confirmed user; on every
   * other path a decoy argon2id hash runs so timing is equalized and MFA-enabled state never leaks.
   */
  async initiate(email: string, ctx: ResetContext): Promise<InitiateResult> {
    const ttlSeconds =
      this.config.get<number>("PWRESET_CHALLENGE_TTL") ??
      PWRESET_CHALLENGE_TTL_DEFAULT;
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        mfaEnabled: true,
        mfaConfirmedAt: true,
        status: true,
      },
    });

    const eligible =
      !!user &&
      user.status === "ACTIVE" &&
      user.mfaEnabled &&
      !!user.mfaConfirmedAt;
    if (!eligible) {
      // Equalize timing: the eligible branch performs an argon2id hash inside challenge.create(); do the
      // same amount of work here against a non-secret decoy so the two branches are indistinguishable.
      await argonHash(DECOY_PASSWORD);
      await this.audit.record({
        actorUserId: user?.id ?? null,
        action: "password.reset.initiate",
        resourceType: "auth.password",
        outcome: "SUCCESS",
        context: { email: maskEmail(email), eligible: false },
        ipHash: hashIp(ctx.ip),
      });
      // Set a structurally-valid DECOY cookie on this ineligible branch too, so EVERY
      // response carries a `Set-Cookie: ftd_pwreset` header — its presence no longer reveals that the
      // account exists AND has confirmed MFA. The decoy references no challenge row, so loadOpen
      // fail-closes on it (a later verify-code/verify returns the same Auth.ResetChallenge* envelope
      // as any wrong token); it can never authorize a password change.
      return {
        challengeToken: decoyChallengeToken(),
        challengeTtlSeconds: ttlSeconds,
      };
    }

    const { token } = await this.challenges.create({
      userId: user.id,
      purpose: PasswordResetPurpose.PasswordReset,
      ttlSeconds,
      maxAttempts:
        this.config.get<number>("PWRESET_MAX_ATTEMPTS") ??
        PWRESET_MAX_ATTEMPTS_DEFAULT,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.audit.record({
      actorUserId: user.id,
      action: "password.reset.initiate",
      resourceType: "auth.password",
      outcome: "SUCCESS",
      context: { email: maskEmail(email), eligible: true },
      ipHash: hashIp(ctx.ip),
    });
    return { challengeToken: token, challengeTtlSeconds: ttlSeconds };
  }

  /**
   * Step 2 of the split flow: verify the second factor ONCE and stamp the challenge.
   * Mirrors the factor half of the former combined verify(): re-bind the device fingerprint, then check
   * the TOTP (advancing the replay floor) or the one-time backup code (consuming it). On success the
   * challenge is atomically stamped `factor_verified_at` (SET-ONCE) so the later password-only /verify
   * carries no code. IDEMPOTENT: if the factor is ALREADY stamped, short-circuit WITHOUT re-running it —
   * a Back/retry/double-tap then neither burns another backup code, advances the floor again, nor spends
   * a brute-force attempt (B2 self-lockout defense). No password is touched here, no session is issued.
   */
  async verifyCode(
    challenge: OpenResetChallenge,
    code: string,
    ctx: ResetContext,
  ): Promise<{ status: "code_verified" }> {
    // Bind the verify-code to the device that initiated: a fingerprint mismatch is a failed factor attempt.
    if (!this.fingerprintMatches(challenge, ctx)) {
      return this.reject(challenge, ctx);
    }

    // Idempotent: the factor is already proven for this challenge — do NOT re-run or re-spend it. A
    // correct Back+resubmit (or a double-tap) returns success without touching the floor/backup/attempts.
    if (challenge.factorVerifiedAt) {
      return { status: "code_verified" };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: { id: true, totpSecretEnc: true, lastUsedTotpStep: true },
    });
    if (!user) return this.reject(challenge, ctx);

    const trimmed = code.trim();
    const method: ResetMethod = /^\d{6}$/.test(trimmed)
      ? "totp"
      : "backup_code";
    const factorOk =
      method === "totp"
        ? await this.verifyTotp(user, trimmed)
        : await this.backupCodes.verify(user.id, trimmed);
    if (!factorOk) return this.reject(challenge, ctx);

    // Atomically stamp the factor (SET-ONCE). A lost race (already stamped/consumed by a concurrent call)
    // is treated as a spent challenge — fail closed rather than silently letting two factors be spent.
    if (!(await this.challenges.markFactorVerified(challenge.id, method))) {
      throw new UnauthorizedException({
        code: "Auth.ResetChallengeConsumed",
        message: "The password-reset challenge was already used.",
      });
    }

    await this.audit.record({
      actorUserId: user.id,
      action: "password.reset.verify_code",
      resourceType: "auth.password",
      outcome: "SUCCESS",
      context: { method },
      ipHash: hashIp(ctx.ip),
    });
    return { status: "code_verified" };
  }

  /**
   * Step 3 of the split flow: complete the reset with the new password ONLY (the factor
   * was already proven at verify-code). Re-enforce the bound IP/UA fingerprint (B1: the stamp->password
   * window must not let a stolen cookie complete from a different device), REQUIRE a stamped factor
   * (`Auth.ResetFactorRequired` when absent — the gate that replaces the old in-call factor check),
   * validate + reject same-password, then atomically consume the challenge + change the password +
   * revoke ALL of the user's trust. No session is issued (forces a fresh /login).
   */
  async verify(
    challenge: OpenResetChallenge,
    newPassword: string,
    ctx: ResetContext,
  ): Promise<void> {
    // Re-bind the device on the password call too — defense-in-depth for the stamp->password window.
    if (!this.fingerprintMatches(challenge, ctx)) {
      return this.reject(challenge, ctx);
    }

    // The second factor must already be proven at verify-code; otherwise no password change is authorized.
    if (!challenge.factorVerifiedAt) {
      throw new UnauthorizedException({
        code: "Auth.ResetFactorRequired",
        message:
          "Verify your authentication code before setting a new password.",
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) return this.reject(challenge, ctx);

    // Validate the new-password FORMAT (no oracle) before the same-password check.
    this.assertStrongPassword(newPassword);

    // Same-password check stays gated behind a verified factor — the gate is now `factorVerifiedAt`
    // (non-null, checked above), replacing the old in-call factor check. So a challenge-cookie holder
    // cannot probe the current password without first proving the factor at verify-code. No consume yet.
    if (await argonVerify(user.passwordHash, newPassword).catch(() => false)) {
      throw new BadRequestException({
        code: "Auth.SamePassword",
        message: "The new password must differ from the current one.",
      });
    }

    const newHash = await argonHash(newPassword);
    const now = new Date();
    // ONE transaction: atomic consume (race-loss -> 401) + password change + revoke-all.
    const consumed = await this.prisma.$transaction(async (tx) => {
      if (!(await this.challenges.consume(challenge.id, tx))) return false;
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash, failedLoginCount: 0, lockedUntil: null },
      });
      // Revoke ALL of the user's trust. The CURRENT challenge is excluded here — it is consumed above in
      // the same tx — and every OTHER open reset challenge is closed by the helper.
      await this.revokeAllTrust(tx, user.id, now, challenge.id);
      return true;
    });
    if (!consumed) {
      // Lost the single-use race — another request already reset the password for this challenge.
      throw new UnauthorizedException({
        code: "Auth.ResetChallengeConsumed",
        message: "The password-reset challenge was already used.",
      });
    }

    await this.audit.record({
      actorUserId: user.id,
      action: "password.reset.complete",
      resourceType: "auth.password",
      resourceId: user.id,
      outcome: "SUCCESS",
      context: { method: challenge.factorMethod },
      ipHash: hashIp(ctx.ip),
    });

    // A15 completion hook: if this challenge was granted by an admin-approved reset REQUEST, stamp the
    // request completed (terminal — the status endpoint stops re-minting challenges for it) and leave a
    // completion audit row. A no-op for the ordinary MFA-factored reset (no request row references the
    // challenge). Runs AFTER the consume transaction — the password change never depends on it.
    const linkedRequest = await this.prisma.passwordResetRequest.findFirst({
      where: { challengeId: challenge.id, completedAt: null },
      select: { id: true },
    });
    if (linkedRequest) {
      await this.prisma.passwordResetRequest.updateMany({
        where: { id: linkedRequest.id, completedAt: null },
        data: { completedAt: now },
      });
      await this.audit.record({
        actorUserId: user.id,
        action: "password.reset_request.complete",
        resourceType: "auth.password_reset_request",
        resourceId: linkedRequest.id,
        outcome: "SUCCESS",
        context: {},
        ipHash: hashIp(ctx.ip),
      });
    }
  }

  /**
   * Administrator fallback: set a working password for a target operator who
   * CANNOT self-serve via the MFA-gated /password/reset flow (e.g. no MFA enrolled, or locked out). The
   * `auth.password.admin_reset` permission gate is enforced at the controller (deny-by-default). Mirrors
   * the MFA admin-reset: clears lock state and REVOKES ALL of the target's refresh tokens, remembered
   * devices, live MFA challenges, and open reset challenges — a full lockout reset. NO session/token is
   * issued (the user signs in with the new password, told out-of-band). Audited with actor + target; the
   * new password is NEVER logged or placed in the audit context.
   */
  async adminReset(
    actorUserId: string,
    targetUserId: string,
    newPassword: string,
  ): Promise<void> {
    // A self-reset via the admin path would bypass the self-service MFA re-auth — forbidden
    // for the highest-privilege role. Checked FIRST so it never depends on the target lookup.
    if (actorUserId === targetUserId) {
      throw new ForbiddenException({
        code: "Auth.SelfResetForbidden",
        message:
          "Use the self-service password reset to change your own password.",
      });
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException({
        code: "Auth.UserNotFound",
        message: "No such user.",
      });
    }

    // Same-as-current is intentionally NOT checked on the admin path: the admin does not know (and must not
    // learn) the target's current password. Only the FORMAT policy applies. Validate BEFORE the tx.
    this.assertStrongPassword(newPassword);

    const newHash = await argonHash(newPassword);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: target.id },
        data: { passwordHash: newHash, failedLoginCount: 0, lockedUntil: null },
      });
      // No challenge to exclude on the admin path → close EVERY open reset challenge for the target.
      await this.revokeAllTrust(tx, target.id, now);
    });

    await this.audit.record({
      actorUserId,
      action: "password.admin_reset",
      resourceType: "auth.password",
      resourceId: target.id,
      outcome: "SUCCESS",
      context: { targetUserId: target.id },
    });

    // Residual: tell the TARGET operator their password was reset by an admin (recipient-scoped
    // security notification — SEPARATE from the audit trail above). Recipient is the TARGET, never the actor.
    // PII-free (params stay {}). BEST-EFFORT: a notification failure must NEVER fail the password reset, which
    // has already committed; swallow + warn so the security side effect can't undo a completed credential change.
    try {
      await this.notifications.emit({
        recipientUserId: target.id,
        type: "SECURITY_ALERT",
        severity: "critical",
        titleKey: "notifications.security.adminPasswordReset.title",
        bodyKey: "notifications.security.adminPasswordReset.body",
        params: {},
        resourceType: "user",
        resourceId: target.id,
      });
    } catch (error) {
      this.logger.warn(
        `Admin-password-reset notification to ${target.id} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * Revoke ALL of a user's trust inside the caller's transaction: refresh tokens, remembered devices, live
   * MFA challenges, and open reset challenges. Shared by verify() and adminReset() (DRY). When
   * `exceptResetChallengeId` is given, that one reset challenge is left untouched (verify() consumes it
   * separately in the same tx); otherwise every open reset challenge is closed.
   */
  private async revokeAllTrust(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
    exceptResetChallengeId?: string,
  ): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.rememberedDevice.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.mfaChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    });
    await tx.passwordResetChallenge.updateMany({
      where: {
        userId,
        consumedAt: null,
        ...(exceptResetChallengeId
          ? { id: { not: exceptResetChallengeId } }
          : {}),
      },
      data: { consumedAt: now },
    });
  }

  /** True when no fingerprint was bound (older challenge / no signal) OR the presented IP+UA match. */
  private fingerprintMatches(
    challenge: OpenResetChallenge,
    ctx: ResetContext,
  ): boolean {
    const ipOk =
      challenge.createdIpHash === null ||
      challenge.createdIpHash === hashIp(ctx.ip);
    const uaOk =
      challenge.uaHash === null || challenge.uaHash === hashUa(ctx.userAgent);
    return ipOk && uaOk;
  }

  /** Verify a 6-digit TOTP, advancing the replay floor on success (a code is accepted at most once). */
  private async verifyTotp(
    user: {
      id: string;
      totpSecretEnc: string | null;
      lastUsedTotpStep: number | null;
    },
    code: string,
  ): Promise<boolean> {
    if (!user.totpSecretEnc) return false;
    const secret = await this.totp.decryptSecret(user.totpSecretEnc, user.id);
    const result = await this.totp.verify(secret, code, user.lastUsedTotpStep);
    if (!result.ok) return false;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastUsedTotpStep: result.usedStep },
    });
    return true;
  }

  /**
   * Count the bad attempt (per-challenge; the challenge fails closed at maxAttempts), audit a generic
   * FAIL (NEVER the code), and throw a stable 401. registerFailedAttempt NEVER touches the user's
   * failedLoginCount / lockedUntil — the victim is never locked by reset attempts.
   */
  private async reject(
    challenge: OpenResetChallenge,
    ctx: ResetContext,
  ): Promise<never> {
    await this.challenges.registerFailedAttempt(challenge.id);
    await this.audit.record({
      actorUserId: challenge.userId,
      action: "password.reset.verify",
      resourceType: "auth.password",
      outcome: "FAIL",
      context: { reason: "invalid_code" },
      ipHash: hashIp(ctx.ip),
    });
    throw new UnauthorizedException({
      code: "Auth.ResetInvalidCode",
      message: "Invalid or expired code.",
    });
  }

  /**
   * Server-side new-password policy (mirrors Web/src/app/features/auth/password-policy.ts BUT min 12):
   * length 12..64 + at least one upper, lower, digit, and symbol. Throws the stable `Auth.WeakPassword`.
   */
  private assertStrongPassword(password: string): void {
    const longEnough =
      password.length >= PWRESET_PASSWORD_MIN_LENGTH &&
      password.length <= PWRESET_PASSWORD_MAX_LENGTH;
    const ok =
      longEnough &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password);
    if (!ok) {
      throw new BadRequestException({
        code: "Auth.WeakPassword",
        message:
          "Password must be 12-64 characters and include upper, lower, digit, and symbol.",
      });
    }
  }
}

/**
 * A structurally-valid `pwr_<uuid>.<secret>` token that references NO challenge row, used
 * as the ineligible-branch decoy cookie so the initiate Set-Cookie header is uniform across account
 * states. It can never authorize anything — loadOpen parses it, looks the id up, finds nothing, and
 * fail-closes to null. The secret is fresh random bytes (never stored, never compared).
 */
function decoyChallengeToken(): string {
  return `${PWRESET_CHALLENGE_TOKEN_PREFIX}${uuidv7()}.${randomBytes(32).toString("base64url")}`;
}

function hashIp(ip?: string): string | null {
  return ip ? sha256(ip) : null;
}

function hashUa(ua?: string): string | null {
  return ua ? sha256(ua) : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
