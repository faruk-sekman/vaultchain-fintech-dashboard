/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * JWT access-secret rotation seam (audit D-14), OPT-IN on `JWT_ACCESS_SECRET_PREVIOUS`.
 *
 * Tokens are always SIGNED with the current `JWT_ACCESS_SECRET` (the JwtModule default). VERIFY tries
 * the current secret first and, ONLY if `JWT_ACCESS_SECRET_PREVIOUS` is set, falls back to the previous
 * secret — so the signing key can be rotated (current ← new, previous ← old) WITHOUT invalidating the
 * still-live access tokens minted under the old key. With the env var unset, behaviour is unchanged:
 * verification is current-secret-only (the JwtModule default), exactly as before.
 *
 * No secret value is ever logged or returned; only the verified payload (on success) escapes.
 */
import type { JwtService, JwtVerifyOptions } from '@nestjs/jwt';

/**
 * Verify a token against the current access secret, falling back to the previous secret when one is
 * configured. Returns the decoded payload, or throws (caller maps to 401) when neither secret accepts
 * the token. The default-secret attempt uses the JwtModule config (so `JWT_ACCESS_SECRET` need not be
 * re-read here); the fallback overrides only the `secret`.
 */
export async function verifyWithRotation<T extends object = Record<string, unknown>>(
  jwt: JwtService,
  token: string,
  options: JwtVerifyOptions = {},
): Promise<T> {
  try {
    // Primary: current secret (JwtModule default). Unchanged path when no previous secret is set.
    return await jwt.verifyAsync<T>(token, options);
  } catch (currentError) {
    const previous = process.env.JWT_ACCESS_SECRET_PREVIOUS;
    if (typeof previous !== 'string' || previous.trim().length === 0) {
      // Rotation disabled → current-secret-only behaviour: surface the original failure.
      throw currentError;
    }
    // Fallback: a token still signed with the previous secret stays valid through the rotation window.
    return await jwt.verifyAsync<T>(token, { ...options, secret: previous });
  }
}
