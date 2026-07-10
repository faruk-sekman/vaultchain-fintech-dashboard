/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * TOTP service. RFC-6238 time-based one-time passwords (otplib v13,
 * Google-Authenticator compatible) — the second factor itself. Responsibilities: mint a Base32 secret,
 * build the otpauth:// enrolment URI + its QR data-URL, verify a 6-digit code within ±MFA_TOTP_WINDOW
 * steps, and ENCRYPT/decrypt the secret at rest. Replay protection is built in: `afterTimeStep` rejects
 * any code whose time-step was already used, and the accepted step is returned to persist as
 * `User.lastUsedTotpStep`. The secret is envelope-encrypted (reuses the PII master key) and
 * bound to its user via AAD, so a stolen ciphertext can't be replanted. Plaintext secrets/codes are
 * never logged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';
import { toDataURL } from 'qrcode';
import { PII_ENCRYPTOR } from '../../common/crypto/crypto.module';
import { packEnvelope, unpackEnvelope } from '../../common/crypto/envelope-codec';
import type { EnvelopeEncryptor } from '../../common/crypto/envelope-encryptor';

const TOTP_PERIOD = 30; // seconds per step (RFC-6238 default; authenticator-app standard)
const TOTP_DIGITS = 6;
const TOTP_ALGORITHM = 'sha1';

export interface TotpVerifyResult {
  ok: boolean;
  /** The accepted RFC-6238 time-step. Persist as `User.lastUsedTotpStep` to block in-window replay. */
  usedStep?: number;
}

@Injectable()
export class TotpService {
  constructor(
    private readonly config: ConfigService,
    @Inject(PII_ENCRYPTOR) private readonly encryptor: EnvelopeEncryptor,
  ) {}

  /** A fresh Base32 secret (Google-Authenticator compatible). Plaintext — encrypt before persisting. */
  generateSecret(): string {
    return generateSecret();
  }

  /** Build the otpauth:// URI the authenticator app imports (issuer from MFA_ISSUER). */
  keyUri(accountLabel: string, secret: string): string {
    return generateURI({
      issuer: this.issuer,
      label: accountLabel,
      secret,
      period: TOTP_PERIOD,
      digits: TOTP_DIGITS,
      algorithm: TOTP_ALGORITHM,
    });
  }

  /** Render the otpauth URI as a PNG data-URL for the enrolment QR. */
  qrDataUrl(otpauthUri: string): Promise<string> {
    return toDataURL(otpauthUri);
  }

  /**
   * Verify a code against the secret within ±MFA_TOTP_WINDOW steps, rejecting any step at or below
   * `afterStep` (replay). On success returns the accepted step to persist as `lastUsedTotpStep`.
   */
  async verify(secret: string, token: string, afterStep?: number | null): Promise<TotpVerifyResult> {
    const result = await verify({
      secret,
      token,
      period: TOTP_PERIOD,
      digits: TOTP_DIGITS,
      algorithm: TOTP_ALGORITHM,
      epochTolerance: this.windowSteps * TOTP_PERIOD, // ±window steps, expressed in seconds
      afterTimeStep: afterStep ?? undefined,
    });
    if (result.valid && 'timeStep' in result && typeof result.timeStep === 'number') {
      return { ok: true, usedStep: result.timeStep };
    }
    return { ok: false };
  }

  /** Envelope-encrypt the secret for the `totp_secret_enc` column (base64 of the packed envelope). */
  async encryptSecret(secret: string, userId: string): Promise<string> {
    const sealed = await this.encryptor.encrypt(Buffer.from(secret, 'utf8'), aad(userId));
    return packEnvelope(sealed).toString('base64');
  }

  /** Reverse {@link encryptSecret}; throws if the ciphertext was bound to a different user (AAD). */
  async decryptSecret(encoded: string, userId: string): Promise<string> {
    const sealed = unpackEnvelope(Buffer.from(encoded, 'base64'));
    return (await this.encryptor.decrypt(sealed, aad(userId))).toString('utf8');
  }

  private get issuer(): string {
    return this.config.get<string>('MFA_ISSUER') ?? 'Fintech Dashboard';
  }

  private get windowSteps(): number {
    return this.config.get<number>('MFA_TOTP_WINDOW') ?? 1;
  }
}

/** Binds the secret's ciphertext to its user so a stolen blob can't be replanted under another user. */
function aad(userId: string): Buffer {
  return Buffer.from(`mfa-totp:${userId}`, 'utf8');
}
