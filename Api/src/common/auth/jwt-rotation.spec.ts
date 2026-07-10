/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the JWT access-secret rotation helper (audit D-14). Pins the
 * contract: current-secret-first, previous-secret fallback ONLY when JWT_ACCESS_SECRET_PREVIOUS is
 * set, and the original failure surfaces when rotation is disabled.
 */
import type { JwtService } from '@nestjs/jwt';
import { verifyWithRotation } from './jwt-rotation';

describe('verifyWithRotation', () => {
  const ORIGINAL = process.env.JWT_ACCESS_SECRET_PREVIOUS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    else process.env.JWT_ACCESS_SECRET_PREVIOUS = ORIGINAL;
  });

  it('returns the payload from the current secret without consulting the previous secret', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = 'previous-secret-min-16-chars';
    const verifyAsync = jest.fn().mockResolvedValue({ sub: 'u1' });
    const jwt = { verifyAsync } as unknown as JwtService;

    await expect(verifyWithRotation(jwt, 'tok')).resolves.toEqual({ sub: 'u1' });
    expect(verifyAsync).toHaveBeenCalledTimes(1);
    expect(verifyAsync).toHaveBeenCalledWith('tok', {});
  });

  it('falls back to the previous secret when the current secret rejects (rotation enabled)', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = 'previous-secret-min-16-chars';
    const verifyAsync = jest
      .fn()
      .mockRejectedValueOnce(new Error('bad signature'))
      .mockResolvedValueOnce({ sub: 'u2' });
    const jwt = { verifyAsync } as unknown as JwtService;

    await expect(verifyWithRotation(jwt, 'tok')).resolves.toEqual({ sub: 'u2' });
    expect(verifyAsync).toHaveBeenCalledTimes(2);
    expect(verifyAsync).toHaveBeenLastCalledWith('tok', { secret: 'previous-secret-min-16-chars' });
  });

  it('surfaces the original failure (no fallback) when the previous secret is unset', async () => {
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    const verifyAsync = jest.fn().mockRejectedValue(new Error('expired'));
    const jwt = { verifyAsync } as unknown as JwtService;

    await expect(verifyWithRotation(jwt, 'tok')).rejects.toThrow('expired');
    expect(verifyAsync).toHaveBeenCalledTimes(1);
  });

  it('treats a blank previous secret as unset (no fallback)', async () => {
    process.env.JWT_ACCESS_SECRET_PREVIOUS = '   ';
    const verifyAsync = jest.fn().mockRejectedValue(new Error('expired'));
    const jwt = { verifyAsync } as unknown as JwtService;

    await expect(verifyWithRotation(jwt, 'tok')).rejects.toThrow('expired');
    expect(verifyAsync).toHaveBeenCalledTimes(1);
  });

  it('forwards caller options into the primary verify', async () => {
    delete process.env.JWT_ACCESS_SECRET_PREVIOUS;
    const verifyAsync = jest.fn().mockResolvedValue({ sub: 'u3' });
    const jwt = { verifyAsync } as unknown as JwtService;

    await verifyWithRotation(jwt, 'tok', { ignoreExpiration: true });
    expect(verifyAsync).toHaveBeenCalledWith('tok', { ignoreExpiration: true });
  });
});
