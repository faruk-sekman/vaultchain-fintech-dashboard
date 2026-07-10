/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for TotpService. otplib + qrcode are mocked (the library's TOTP maths is
 * its own concern + is proven type-correct by the build; the real end-to-end TOTP/replay flow is
 * covered by the P7 API-E2E suite, where Node loads otplib's CJS build natively). These tests pin down
 * TotpService's own logic: the otpauth-URI request shape, the verify option-building (±window →
 * epochTolerance) + replay passthrough (afterTimeStep), the valid→{ok,usedStep} result mapping, the
 * fail-closed branch when a step is missing, and the AAD-bound envelope round-trip (real encryptor).
 */
jest.mock('otplib', () => ({ generateSecret: jest.fn(), generateURI: jest.fn(), verify: jest.fn() }));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';
import { toDataURL } from 'qrcode';
import { LocalKeyEncryptor } from '../../common/crypto/local-key-encryptor';
import { TotpService } from './totp.service';

const mGenerateSecret = generateSecret as jest.Mock;
const mGenerateURI = generateURI as jest.Mock;
const mVerify = verify as jest.Mock;
const mToDataURL = toDataURL as jest.Mock;

/** Build a service over a config whose `get` is supplied by the caller (so each test pins its env). */
function makeServiceWith(get: (key: string) => unknown): TotpService {
  const config = { get: jest.fn(get) } as unknown as ConfigService;
  const encryptor = new LocalKeyEncryptor(new Map([['k1', randomBytes(32)]]), 'k1');
  return new TotpService(config, encryptor);
}

function makeService(): TotpService {
  return makeServiceWith((key: string) => ({ MFA_ISSUER: 'Fintech Test', MFA_TOTP_WINDOW: 1 } as Record<string, unknown>)[key]);
}

beforeEach(() => jest.clearAllMocks());

describe('TotpService', () => {
  it('#1 generateSecret delegates to otplib', () => {
    mGenerateSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    expect(makeService().generateSecret()).toBe('JBSWY3DPEHPK3PXP');
  });

  it('#2 keyUri requests an otpauth URI with the configured issuer + RFC-6238 params', () => {
    mGenerateURI.mockReturnValue('otpauth://totp/x');
    makeService().keyUri('op@demo', 'SECRET');
    expect(mGenerateURI).toHaveBeenCalledWith({
      issuer: 'Fintech Test',
      label: 'op@demo',
      secret: 'SECRET',
      period: 30,
      digits: 6,
      algorithm: 'sha1',
    });
  });

  it('#3 verify maps a valid result to { ok, usedStep } and sends ±window as epochTolerance seconds', async () => {
    mVerify.mockResolvedValue({ valid: true, delta: 0, timeStep: 4242, epoch: 1 });
    const res = await makeService().verify('SECRET', '123456');
    expect(res).toEqual({ ok: true, usedStep: 4242 });
    expect(mVerify).toHaveBeenCalledWith(expect.objectContaining({ secret: 'SECRET', token: '123456', epochTolerance: 30 }));
  });

  it('#4 verify rejects an invalid code and forwards afterStep for replay protection', async () => {
    mVerify.mockResolvedValue({ valid: false });
    const res = await makeService().verify('SECRET', '000000', 4242);
    expect(res).toEqual({ ok: false });
    expect(mVerify).toHaveBeenCalledWith(expect.objectContaining({ afterTimeStep: 4242 }));
  });

  it('#5 a valid result without a numeric timeStep is treated as not-ok (fail-closed — replay needs the step)', async () => {
    mVerify.mockResolvedValue({ valid: true });
    expect(await makeService().verify('SECRET', '123456')).toEqual({ ok: false });
  });

  it('#6 encryptSecret/decryptSecret round-trip; the ciphertext is AAD-bound to the user', async () => {
    const svc = makeService();
    const enc = await svc.encryptSecret('JBSWY3DPEHPK3PXP', 'user-1');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await svc.decryptSecret(enc, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    await expect(svc.decryptSecret(enc, 'user-2')).rejects.toThrow(); // AAD mismatch → GCM auth-tag failure
  });

  it('#7 qrDataUrl delegates to qrcode.toDataURL', async () => {
    mToDataURL.mockResolvedValue('data:image/png;base64,FAKE');
    expect(await makeService().qrDataUrl('otpauth://totp/x')).toMatch(/^data:image\/png/);
  });

  // Config-default branches: when MFA_ISSUER / MFA_TOTP_WINDOW are unset, the service must fall back to
  // its documented defaults ('Fintech Dashboard' issuer; ±1-step window → 30s epochTolerance). The base
  // config mock always returns values, so these exercise the `?? default` arms explicitly.
  describe('config defaults (unset env → documented fallbacks)', () => {
    const emptyConfig = makeServiceWith(() => undefined);

    it('#8 keyUri falls back to the default "Fintech Dashboard" issuer when MFA_ISSUER is unset', () => {
      mGenerateURI.mockReturnValue('otpauth://totp/x');
      emptyConfig.keyUri('op@demo', 'SECRET');
      expect(mGenerateURI).toHaveBeenCalledWith(expect.objectContaining({ issuer: 'Fintech Dashboard' }));
    });

    it('#9 verify falls back to a ±1-step window (epochTolerance 30s) when MFA_TOTP_WINDOW is unset', async () => {
      mVerify.mockResolvedValue({ valid: true, timeStep: 1 });
      await emptyConfig.verify('SECRET', '123456');
      expect(mVerify).toHaveBeenCalledWith(expect.objectContaining({ epochTolerance: 30 })); // 1 step * 30s
    });
  });
});
