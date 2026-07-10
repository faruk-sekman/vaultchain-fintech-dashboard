/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Jest test-runtime setup (TEST-001): silence Nest's default Logger during test runs so
 * negative-path specs (which deliberately exercise WARN/ERROR/DEBUG branches) don't flood the
 * console. This ONLY affects the Jest runtime — production/dev logging is untouched, because this
 * file is wired through `setupFilesAfterEnv` (unit) / the int config and never loads outside Jest.
 *
 * Specs that ASSERT logging still work: they spy on `Logger.prototype.*` directly, and a spy wraps
 * the whole method, so the call is still recorded even though the underlying output is suppressed.
 *
 * (For integration specs that boot the real AppModule, pino is additionally silenced in
 * app.module.ts, gated on JEST_WORKER_ID — see the LoggerModule.forRoot pinoHttp config.)
 */
'use strict';

const { Logger } = require('@nestjs/common');

// `false` disables Nest's default logger output for every `new Logger(context)` instance.
Logger.overrideLogger(false);

// Mandatory-MFA gate (F3): the seed/test users are NOT MFA-enrolled, so the F3 fail-closed check would
// 403 every seed login whenever MFA_REQUIRED is ON. Force it OFF for the Jest runtime so integration
// specs that boot the real AppModule can sign in. Set here — before any spec's beforeAll boots Nest —
// so it wins over a developer's local Api/.env (NestJS merges process.env last). A spec that needs the
// gate ON can still override it in its own beforeAll. Production/dev config is untouched (Jest-only file).
process.env.MFA_REQUIRED = 'false';
