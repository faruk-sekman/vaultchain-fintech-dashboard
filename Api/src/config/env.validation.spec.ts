/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for validateEnv (audit 9C). Covers the happy path (with implicit PORT conversion + the
 * NODE_ENV default), the fail-fast error path for each required/bounded variable, and the production
 * fail-closed rules: HARDENING-1 Redis-TLS/AUTH, HARDENING-2 strong JWT
 * secrets (re-audit SEC-API), HARDENING-3 THROTTLE_DISABLED refused (re-audit THR-001), and
 * HARDENING-4 explicit CORS allowlist (re-audit CORS-P3).
 */
import 'reflect-metadata';
import { NodeEnv, validateEnv } from './env.validation';

// A production-shaped config: strong (>=32, non-placeholder) JWT secrets + an explicit CORS allowlist,
// so it satisfies HARDENING-2/4 (the production fail-closed rules) as a baseline for override tests.
const VALID = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CORS_ORIGINS: 'https://app.example.com',
};

describe('validateEnv', () => {
  it('returns the validated config and converts PORT to a number', () => {
    const result = validateEnv(VALID);
    expect(result.NODE_ENV).toBe(NodeEnv.Production);
    expect(result.PORT).toBe(3000);
    expect(result.DATABASE_URL).toBe(VALID.DATABASE_URL);
  });

  it('applies the Development default when NODE_ENV is absent', () => {
    const { NODE_ENV: _omit, ...rest } = VALID;
    expect(validateEnv(rest).NODE_ENV).toBe(NodeEnv.Development);
  });

  it('throws a summarised error when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = VALID;
    expect(() => validateEnv(rest)).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('throws when a JWT secret is too short', () => {
    expect(() => validateEnv({ ...VALID, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('throws when JWT_ACCESS_SECRET_PREVIOUS is set but too short', () => {
    expect(() => validateEnv({ ...VALID, JWT_ACCESS_SECRET_PREVIOUS: 'short' })).toThrow(/JWT_ACCESS_SECRET_PREVIOUS/);
  });

  it('throws on an invalid NODE_ENV', () => {
    expect(() => validateEnv({ ...VALID, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('throws on an out-of-range PORT', () => {
    expect(() => validateEnv({ ...VALID, PORT: '70000' })).toThrow(/PORT/);
  });

  it('accepts the optional PII key fields when present', () => {
    const result = validateEnv({ ...VALID, FTD_PII_MASTER_KEY: 'a'.repeat(44), FTD_PII_KEY_ID: 'dev-key-1' });
    expect(result.FTD_PII_MASTER_KEY).toBe('a'.repeat(44));
    expect(result.FTD_PII_KEY_ID).toBe('dev-key-1');
  });

  it('accepts an optional MIGRATE_DATABASE_URL when present (SEC-003 two-role seam)', () => {
    const url = 'postgresql://migrator@localhost:5432/db';
    expect(validateEnv({ ...VALID, MIGRATE_DATABASE_URL: url }).MIGRATE_DATABASE_URL).toBe(url);
  });

  it('boots without MIGRATE_DATABASE_URL (single-URL model unchanged)', () => {
    expect(validateEnv(VALID).MIGRATE_DATABASE_URL).toBeUndefined();
  });

  it('reports multiple failing variables together', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging', PORT: '0' })).toThrow(/NODE_ENV.*PORT|PORT.*NODE_ENV|DATABASE_URL/s);
  });

  describe('HARDENING-1: production Redis must use TLS or AUTH', () => {
    it('boots with REDIS_URL unset in production (seam disabled — unchanged)', () => {
      expect(validateEnv(VALID).REDIS_URL).toBeUndefined();
    });

    it('rejects a plaintext, unauthenticated REDIS_URL in production', () => {
      expect(() => validateEnv({ ...VALID, REDIS_URL: 'redis://localhost:6379' })).toThrow(/REDIS_URL/);
      expect(() => validateEnv({ ...VALID, REDIS_URL: 'redis://localhost:6379' })).toThrow(/TLS|AUTH/);
    });

    it('accepts a TLS (rediss://) REDIS_URL in production', () => {
      const result = validateEnv({ ...VALID, REDIS_URL: 'rediss://cache.internal:6380' });
      expect(result.REDIS_URL).toBe('rediss://cache.internal:6380');
    });

    it('accepts a plaintext REDIS_URL that carries an AUTH password in production', () => {
      const result = validateEnv({ ...VALID, REDIS_URL: 'redis://:s3cret@cache.internal:6379' });
      expect(result.REDIS_URL).toBe('redis://:s3cret@cache.internal:6379');
    });

    it('rejects a malformed REDIS_URL in production', () => {
      expect(() => validateEnv({ ...VALID, REDIS_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
    });

    it('allows a plaintext REDIS_URL in NON-production (dev/test unchanged)', () => {
      const result = validateEnv({ ...VALID, NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379' });
      expect(result.REDIS_URL).toBe('redis://localhost:6379');
    });
  });

  describe('HARDENING-2: production JWT secrets must be strong (re-audit SEC-API)', () => {
    it('rejects a documented change-me placeholder secret in production', () => {
      expect(() => validateEnv({ ...VALID, JWT_ACCESS_SECRET: 'change-me-local-dev-only-min-16' })).toThrow(
        /JWT_ACCESS_SECRET/,
      );
      expect(() => validateEnv({ ...VALID, JWT_ACCESS_SECRET: 'change-me-local-dev-only-min-16' })).toThrow(
        /placeholder/,
      );
    });

    it('rejects a JWT secret that is >=16 but shorter than 32 in production', () => {
      expect(() => validateEnv({ ...VALID, JWT_REFRESH_SECRET: 'x'.repeat(20) })).toThrow(/JWT_REFRESH_SECRET/);
      expect(() => validateEnv({ ...VALID, JWT_REFRESH_SECRET: 'x'.repeat(20) })).toThrow(/at least 32/);
    });

    it('rejects a weak JWT_ACCESS_SECRET_PREVIOUS (>=16 but <32) in production', () => {
      expect(() => validateEnv({ ...VALID, JWT_ACCESS_SECRET_PREVIOUS: 'y'.repeat(20) })).toThrow(
        /JWT_ACCESS_SECRET_PREVIOUS/,
      );
    });

    it('accepts strong (>=32, non-placeholder) secrets in production', () => {
      expect(validateEnv(VALID).JWT_ACCESS_SECRET).toBe('a'.repeat(48));
    });

    it('allows a placeholder/short secret in NON-production (dev/test unchanged)', () => {
      const result = validateEnv({
        ...VALID,
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: 'change-me-local-dev-only-min-16',
      });
      expect(result.JWT_ACCESS_SECRET).toBe('change-me-local-dev-only-min-16');
    });
  });

  describe('HARDENING-3: THROTTLE_DISABLED refused in production (re-audit THR-001)', () => {
    it('rejects THROTTLE_DISABLED=1 in production', () => {
      expect(() => validateEnv({ ...VALID, THROTTLE_DISABLED: '1' })).toThrow(/THROTTLE_DISABLED/);
    });

    it('rejects THROTTLE_DISABLED=true in production', () => {
      expect(() => validateEnv({ ...VALID, THROTTLE_DISABLED: 'true' })).toThrow(/THROTTLE_DISABLED/);
    });

    it('allows THROTTLE_DISABLED=1 in NON-production (integration tests unchanged)', () => {
      expect(validateEnv({ ...VALID, NODE_ENV: 'test', THROTTLE_DISABLED: '1' }).NODE_ENV).toBe(NodeEnv.Test);
    });

    it('boots in production when THROTTLE_DISABLED is unset', () => {
      expect(validateEnv(VALID).NODE_ENV).toBe(NodeEnv.Production);
    });
  });

  describe('MFA_REQUIRED coercion (F3 mandatory-MFA gate must not misfire on a string "false")', () => {
    // enableImplicitConversion would turn ANY non-empty string (incl. 'false') into boolean true,
    // wrongly enforcing mandatory MFA and locking out non-enrolled accounts (e.g. the demo seed
    // users). The explicit @Transform must keep only a real true / 'true' truthy.
    it('coerces the string "false" to boolean false (does NOT enforce MFA)', () => {
      expect(validateEnv({ ...VALID, MFA_REQUIRED: 'false' }).MFA_REQUIRED).toBe(false);
    });

    it('coerces the string "true" to boolean true (enforces MFA)', () => {
      expect(validateEnv({ ...VALID, MFA_REQUIRED: 'true' }).MFA_REQUIRED).toBe(true);
    });

    it('defaults to false when MFA_REQUIRED is unset (opt-in default unchanged)', () => {
      expect(validateEnv(VALID).MFA_REQUIRED).toBe(false);
    });
  });

  describe('HARDENING-4: production requires an explicit CORS allowlist (re-audit CORS-P3)', () => {
    it('rejects an unset CORS_ORIGINS in production (fail closed, no localhost fallback)', () => {
      const { CORS_ORIGINS: _omit, ...rest } = VALID;
      expect(() => validateEnv(rest)).toThrow(/CORS_ORIGINS/);
    });

    it('rejects a blank CORS_ORIGINS in production', () => {
      expect(() => validateEnv({ ...VALID, CORS_ORIGINS: '   ' })).toThrow(/CORS_ORIGINS/);
    });

    it('allows an unset CORS_ORIGINS in NON-production (localhost fallback retained)', () => {
      const { CORS_ORIGINS: _omit, ...rest } = VALID;
      expect(validateEnv({ ...rest, NODE_ENV: 'development' }).NODE_ENV).toBe(NodeEnv.Development);
    });
  });
});
