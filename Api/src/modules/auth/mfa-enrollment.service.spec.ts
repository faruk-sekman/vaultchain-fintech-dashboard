/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for MfaEnrollmentService. Collaborators mocked; argon2id runs for real so
 * the password re-auth is genuine. Covers: start (stores an INACTIVE secret, returns URI + QR), wrong
 * password, already-enrolled (409), confirm (activates + returns one-time backup codes), wrong confirm
 * code, no-setup-in-progress (400), confirm-while-enrolled (409), and the backup-code-count config default.
 */
// otplib/qrcode are ESM-first; mock so importing TotpService (via this service) doesn't load otplib src.
jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { BackupCodeService } from '../mfa/backup-code.service';
import type { TotpService } from '../mfa/totp.service';
import { MfaEnrollmentService } from './mfa-enrollment.service';

const PASSWORD = 'correct-horse-battery';
let PASSWORD_HASH: string;
beforeAll(async () => {
  PASSWORD_HASH = await hash(PASSWORD);
});

/** `configGet` lets a test pin what `ConfigService.get` returns (default: MFA_BACKUP_CODE_COUNT = 10). */
function setup(user: Record<string, unknown>, configGet: (key: string) => unknown = () => 10) {
  const prisma = { user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue({}) } };
  const totp = {
    generateSecret: jest.fn().mockReturnValue('SECRET'),
    encryptSecret: jest.fn().mockResolvedValue('enc-blob'),
    keyUri: jest.fn().mockReturnValue('otpauth://totp/Fintech:op@demo?secret=SECRET'),
    qrDataUrl: jest.fn().mockResolvedValue('data:image/png;base64,FAKE'),
    decryptSecret: jest.fn().mockResolvedValue('SECRET'),
    verify: jest.fn(),
  };
  const backupCodes = { generate: jest.fn().mockResolvedValue(['A1B2C-D3E4F', 'G5H6J-K7M8N']) };
  const config = { get: jest.fn(configGet) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new MfaEnrollmentService(
    prisma as unknown as PrismaService,
    totp as unknown as TotpService,
    backupCodes as unknown as BackupCodeService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
  );
  return { svc, prisma, totp, backupCodes, audit };
}

const NOT_ENROLLED = { id: 'u1', email: 'op@demo', passwordHash: '', mfaEnabled: false, mfaConfirmedAt: null };

describe('MfaEnrollmentService.start', () => {
  it('#1 stores an INACTIVE encrypted secret and returns the otpauth URI + QR', async () => {
    const m = setup({ ...NOT_ENROLLED, passwordHash: PASSWORD_HASH });
    const res = await m.svc.start('u1', PASSWORD);
    expect(res.otpauthUri).toMatch(/^otpauth:\/\/totp/);
    expect(res.qrDataUrl).toMatch(/^data:image\/png/);
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { totpSecretEnc: 'enc-blob', mfaEnabled: false, mfaConfirmedAt: null, lastUsedTotpStep: null },
    });
    expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa.enroll.start', outcome: 'SUCCESS' }));
  });

  it('#2 rejects a wrong password and stores nothing', async () => {
    const m = setup({ ...NOT_ENROLLED, passwordHash: PASSWORD_HASH });
    await expect(m.svc.start('u1', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.user.update).not.toHaveBeenCalled();
  });

  it('#2b rejects (and stores nothing) when argon2 verify REJECTS on a corrupt stored hash (the `.catch(() => false)` arm)', async () => {
    // A corrupt passwordHash makes the REAL argon2 `verify` REJECT; assertPassword's `.catch(() => false)`
    // must fail closed → 401 (treated as a wrong password), never a 500 leaking the crypto error, and the
    // sensitive enrolment state is never written. Genuine corrupt-credential-row path, not coverage padding.
    const m = setup({ ...NOT_ENROLLED, passwordHash: 'not-a-valid-argon2-hash' });
    await expect(m.svc.start('u1', PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.user.update).not.toHaveBeenCalled();
  });

  it('#3 rejects (409) when MFA is already enabled', async () => {
    const m = setup({ ...NOT_ENROLLED, passwordHash: PASSWORD_HASH, mfaEnabled: true, mfaConfirmedAt: new Date() });
    await expect(m.svc.start('u1', PASSWORD)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('MfaEnrollmentService.confirm', () => {
  it('#4 the first correct code activates MFA and returns one-time backup codes', async () => {
    const m = setup({ id: 'u1', totpSecretEnc: 'enc-blob', lastUsedTotpStep: null, mfaEnabled: false, mfaConfirmedAt: null });
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 5 });
    const res = await m.svc.confirm('u1', '123456');
    expect(res.backupCodes).toHaveLength(2);
    expect(m.prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { mfaEnabled: true, mfaConfirmedAt: expect.any(Date), lastUsedTotpStep: 5 },
    });
    expect(m.backupCodes.generate).toHaveBeenCalledWith('u1', 10);
    expect(m.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'mfa.enroll.confirm', outcome: 'SUCCESS' }));
  });

  it('#5 a wrong code does NOT activate MFA', async () => {
    const m = setup({ id: 'u1', totpSecretEnc: 'enc-blob', lastUsedTotpStep: null, mfaEnabled: false, mfaConfirmedAt: null });
    m.totp.verify.mockResolvedValue({ ok: false });
    await expect(m.svc.confirm('u1', '000000')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.prisma.user.update).not.toHaveBeenCalled();
    expect(m.backupCodes.generate).not.toHaveBeenCalled();
  });

  it('#6 rejects (400) when no setup is in progress (no stored secret)', async () => {
    const m = setup({ id: 'u1', totpSecretEnc: null, lastUsedTotpStep: null, mfaEnabled: false, mfaConfirmedAt: null });
    await expect(m.svc.confirm('u1', '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('#7 rejects (409) when MFA is already enabled', async () => {
    const m = setup({ id: 'u1', totpSecretEnc: 'enc-blob', lastUsedTotpStep: null, mfaEnabled: true, mfaConfirmedAt: new Date() });
    await expect(m.svc.confirm('u1', '123456')).rejects.toBeInstanceOf(ConflictException);
  });

  it('#8 falls back to the default backup-code count (10) when MFA_BACKUP_CODE_COUNT is unset', async () => {
    // The config returns undefined for the count, exercising the `?? 10` default branch.
    const m = setup(
      { id: 'u1', totpSecretEnc: 'enc-blob', lastUsedTotpStep: null, mfaEnabled: false, mfaConfirmedAt: null },
      () => undefined,
    );
    m.totp.verify.mockResolvedValue({ ok: true, usedStep: 6 });
    await m.svc.confirm('u1', '123456');
    expect(m.backupCodes.generate).toHaveBeenCalledWith('u1', 10); // default count, not undefined
  });
});
