/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Fail-fast environment validation (security baseline): the app refuses to
 * boot with a missing/invalid configuration rather than starting in a degraded state.
 */
import { plainToInstance, Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  // ---------- SEC-003 two-role runtime seam (RLS enforcement) ----------
  // OPTIONAL owner/migrator connection string for DDL + provisioning (prisma migrate,
  // prisma:integrity, prisma:security). Once the app runs as the least-privilege `app_login` role
  // (member of `app_rw`) so RLS actually enforces, migrations still need the table owner — this is that
  // URL. Unset → the single-URL model (unchanged: dev/CI + any deployment not yet split to two roles).
  // Never logged. Design: docs/security/rls-app-connection-design.md.
  @IsOptional()
  @IsString()
  @MinLength(1)
  MIGRATE_DATABASE_URL?: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(16)
  JWT_REFRESH_SECRET!: string;

  // Access-secret rotation seam (audit D-14). OPTIONAL previous access secret: tokens
  // are SIGNED with JWT_ACCESS_SECRET and VERIFIED against current OR this previous value, so the
  // signing key can rotate without invalidating live sessions. Unset → current-only (unchanged).
  @IsOptional()
  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET_PREVIOUS?: string;

  // Horizontal-scale seam (audit D-14). OPTIONAL Redis connection URL: when set, the
  // rate-limiter and the realtime SSE bus use Redis so they work across instances behind a load
  // balancer. Unset → in-memory throttler + single-process SSE (unchanged; the default everywhere).
  // In production a set value MUST use TLS (rediss://) or carry an AUTH component (HARDENING-1; see
  // assertProductionRedisIsSecure) — no plaintext/unauthenticated Redis in prod.
  @IsOptional()
  @IsString()
  @MinLength(1)
  REDIS_URL?: string;

  // PII column-encryption master key: base64-encoded 32 bytes. Optional
  // here so local dev can use the clearly-labeled dev fallback (see crypto.module). REQUIRED in
  // production — the crypto factory fails fast at boot if it is unset with NODE_ENV=production.
  @IsOptional()
  @IsString()
  @MinLength(1)
  FTD_PII_MASTER_KEY?: string;

  @IsOptional()
  @IsString()
  FTD_PII_KEY_ID?: string;

  // ---------- MFA — opt-in TOTP + backup codes + remember-device ----------
  // MFA stays OPT-IN (MFA_REQUIRED defaults false). Every var is OPTIONAL with a safe default (the
  // services fall back to the SAME defaults), so the app boots unconfigured in every environment.
  // Consistent with opt-in there is NO prod fail-closed here — unlike FTD_PII_MASTER_KEY, none of these
  // has an unsafe default. The TOTP secret is per-user + envelope-encrypted at enrolment (reuses
  // FTD_PII_MASTER_KEY) — never set via env.
  @IsOptional()
  @IsString()
  @MinLength(1)
  MFA_ISSUER?: string;

  // RFC-6238 acceptance window in 30s steps (clock-skew tolerance); kept narrow.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  MFA_TOTP_WINDOW: number = 1;

  // Single-use challenge-token lifetime, in seconds.
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  MFA_CHALLENGE_TTL?: number;

  // Max bad-code attempts before a challenge fails closed (per-challenge counter — no victim lockout).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  MFA_MAX_VERIFY_ATTEMPTS?: number;

  // One-time backup recovery codes minted at enrollment.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  MFA_BACKUP_CODE_COUNT: number = 10;

  // Master switch for the optional "remember this device" path (default OFF).
  @IsOptional()
  @IsBoolean()
  MFA_REMEMBER_DEVICE_ENABLED: boolean = false;

  // Remembered-device trust-token lifetime, in seconds.
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(31_536_000)
  MFA_REMEMBER_DEVICE_TTL?: number;

  // Whether MFA is mandatory for sign-in (default false → opt-in; the single seam to flip to mandatory).
  // Coerce EXPLICITLY: `enableImplicitConversion` turns any non-empty string (INCLUDING 'false') into
  // boolean true, which would wrongly enforce mandatory MFA and lock out every non-enrolled account —
  // including the demo seed users. Only a real true / 'true' counts; 'false'/unset stay false.
  @IsOptional()
  @Transform(({ obj }) => {
    // Read the RAW plain input (obj), NOT `value`: with enableImplicitConversion the coercion
    // (Boolean('false') === true) runs BEFORE this transform, so `value` is already the corrupted
    // boolean. `obj.MFA_REQUIRED` is still the original string, so only a real true / 'true' enforces.
    const raw = (obj as Record<string, unknown>).MFA_REQUIRED;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  MFA_REQUIRED: boolean = false;

  // ---------- Password reset — self-service MFA-gated reset ----------
  // Both OPTIONAL with safe defaults (the service falls back to the SAME defaults), so the app boots
  // unconfigured. No prod fail-closed — neither has an unsafe default. There is NO email/JWT secret here.

  // Single-use reset-challenge lifetime, in seconds (default 300).
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  PWRESET_CHALLENGE_TTL?: number;

  // Max bad-factor attempts before a reset challenge fails closed (per-challenge — never a victim lockout).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  PWRESET_MAX_ATTEMPTS?: number;

  // ---------- Admin-approval reset requests (A15/A16, bugfix-backlog-2026-07) ----------
  // Both OPTIONAL with safe in-code defaults (the service falls back to the SAME defaults), so the app
  // boots unconfigured. No prod fail-closed — neither has an unsafe default.

  // Reset-request lifetime, in seconds (default 86 400 = 24 h). ONE TTL covers both the pending-decision
  // and the approved-unclaimed windows; enforced lazily on read (no scheduler).
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604_800)
  PWRESET_REQUEST_TTL?: number;

  // Per-account create cooldown, in seconds (default 600): while the account's newest request row (any
  // status) is younger, a new create is silently skipped (same 202 + decoy cookie — enumeration-safe).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86_400)
  PWRESET_REQUEST_COOLDOWN?: number;
}

/**
 * HARDENING-1 (sec-review / fail-closed): in PRODUCTION a set `REDIS_URL` must NOT be plaintext
 * + unauthenticated. Require either TLS (`rediss://`) or an AUTH component (a password in the URL
 * userinfo, e.g. `redis://:pass@host` / `redis://user:pass@host`). Non-prod (dev/test) is unchanged
 * (any URL allowed) so local/CI need no Redis hardening. Throws (fail-fast at boot) on a violation.
 * Never logs the URL — only the variable name + the rule.
 */
export function assertProductionRedisIsSecure(env: { NODE_ENV?: string; REDIS_URL?: string }): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;
  const url = env.REDIS_URL;
  if (typeof url !== 'string' || url.trim().length === 0) return; // unset → seam disabled, nothing to check.

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'Invalid environment configuration — REDIS_URL: not a valid URL (production requires rediss:// or an AUTH component).',
    );
  }
  const isTls = parsed.protocol === 'rediss:';
  const hasAuth = parsed.password.length > 0 || parsed.username.length > 0;
  if (!isTls && !hasAuth) {
    throw new Error(
      'Invalid environment configuration — REDIS_URL: production Redis must use TLS (rediss://) or carry an AUTH component; plaintext/unauthenticated Redis is refused.',
    );
  }
}

/**
 * HARDENING-2 (audit SEC-API JWT / re-audit 2026-07-01): in PRODUCTION the JWT signing secrets must
 * NOT be a documented placeholder (the committed `.env.example` ships `change-me…` values that satisfy
 * `@MinLength(16)`) or a weak short key. A leaked/guessable signing key lets anyone forge access tokens
 * with arbitrary `sub` + permissions (full privilege escalation). Mirrors the FTD_PII_MASTER_KEY /
 * REDIS_URL prod fail-fast posture. Non-prod is unchanged. Never logs the secret value — only its name.
 */
const PLACEHOLDER_SECRET = /change[-_]?me/i;
const MIN_PROD_SECRET_LENGTH = 32;

export function assertProductionSecretsAreStrong(env: {
  NODE_ENV?: string;
  JWT_ACCESS_SECRET?: string;
  JWT_REFRESH_SECRET?: string;
  JWT_ACCESS_SECRET_PREVIOUS?: string;
}): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;
  const secrets: ReadonlyArray<readonly [string, string | undefined]> = [
    ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
    ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
    ['JWT_ACCESS_SECRET_PREVIOUS', env.JWT_ACCESS_SECRET_PREVIOUS],
  ];
  for (const [name, value] of secrets) {
    if (value === undefined) continue; // PREVIOUS is optional; the required two already passed @MinLength(16).
    if (PLACEHOLDER_SECRET.test(value)) {
      throw new Error(
        `Invalid environment configuration — ${name}: refuses a documented placeholder ('change-me…') secret in production; set a unique high-entropy signing key.`,
      );
    }
    if (value.length < MIN_PROD_SECRET_LENGTH) {
      throw new Error(
        `Invalid environment configuration — ${name}: production signing secrets must be at least ${MIN_PROD_SECRET_LENGTH} characters; refusing a weak key.`,
      );
    }
  }
}

/**
 * HARDENING-3 (audit THR-001): `THROTTLE_DISABLED=1` is the global rate-limit kill-switch consumed by
 * the ThrottlerModule `skipIf` (app.module.ts). It is read straight from `process.env` and is not a
 * validated field, so a leftover CI/test value in production would silently disable ALL rate limiting
 * (auth/reset brute-force protection). Fail closed in production. Non-prod (where int-specs set it) is
 * unchanged.
 */
export function assertProductionThrottlerEnabled(env: { NODE_ENV?: string; THROTTLE_DISABLED?: unknown }): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;
  if (env.THROTTLE_DISABLED === '1' || env.THROTTLE_DISABLED === 'true') {
    throw new Error(
      'Invalid environment configuration — THROTTLE_DISABLED: the global rate-limit kill-switch must not be enabled in production; refusing to boot with rate limiting disabled.',
    );
  }
}

/**
 * HARDENING-4 (audit CORS-P3): a real deployment with `CORS_ORIGINS` unset must fail closed rather than
 * silently trusting the localhost dev origins (main.ts fallback). Because validateEnv runs at
 * ConfigModule init — before `app.enableCors` — this guard aborts a misconfigured production boot.
 * Non-prod keeps the localhost fallback.
 */
export function assertProductionCorsConfigured(env: { NODE_ENV?: string; CORS_ORIGINS?: unknown }): void {
  if (env.NODE_ENV !== NodeEnv.Production) return;
  const value = typeof env.CORS_ORIGINS === 'string' ? env.CORS_ORIGINS.trim() : '';
  if (value.length === 0) {
    throw new Error(
      'Invalid environment configuration — CORS_ORIGINS: production requires an explicit origin allowlist; refusing to fall back to localhost dev origins.',
    );
  }
}

/**
 * Validates `process.env` at startup. Never logs the values themselves (secrets) —
 * only the failing variable names + constraints.
 */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const summary = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${summary}`);
  }
  // Cross-field, env-aware production fail-fast rules that class-validator decorators can't express.
  // THROTTLE_DISABLED / CORS_ORIGINS are consumed as raw process.env strings (not validated fields),
  // so they are read from `config`; NODE_ENV + the JWT secrets come from the validated instance.
  assertProductionRedisIsSecure(validated); // HARDENING-1
  assertProductionSecretsAreStrong(validated); // HARDENING-2
  assertProductionThrottlerEnabled({ NODE_ENV: validated.NODE_ENV, THROTTLE_DISABLED: config.THROTTLE_DISABLED }); // HARDENING-3
  assertProductionCorsConfigured({ NODE_ENV: validated.NODE_ENV, CORS_ORIGINS: config.CORS_ORIGINS }); // HARDENING-4
  return validated;
}
