/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Root module. Wires global config (with fail-fast env validation), structured
 * logging, rate limiting, and the shared response/error envelopes. Domain feature
 * modules (customers, wallets, transactions/ledger, dashboard, risk) are added by
 * their respective tasks (DASH-001 / RISK-001 / SEC-002).
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './common/health/health.controller';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { OperatorContextInterceptor } from './common/context/operator-context.interceptor';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { getApiEnvFilePaths } from './config/env-files';
import { validateEnv } from './config/env.validation';
import { AuditModule } from './common/audit/audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { REDIS_CLIENT } from './infrastructure/redis/redis.constants';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import type Redis from 'ioredis';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { PasswordResetModule } from './modules/password-reset/password-reset.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { OperatorModule } from './modules/operator/operator.module';
import { NotificationModule } from './modules/notification/notification.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RiskModule } from './modules/risk/risk.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: getApiEnvFilePaths(),
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Under Jest, silence pino: no per-request autoLogging and level 'silent', so integration
        // specs don't flood the console with request logs / expected negative-path errors (TEST-001).
        // JEST_WORKER_ID is set ONLY by the Jest runner, so real/dev/prod logging is unchanged.
        autoLogging: !process.env.JEST_WORKER_ID,
        ...(process.env.JEST_WORKER_ID ? { level: 'silent' } : {}),
        // Never log auth material or cookies (fintech defense-in-depth).
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["set-cookie"]'],
      },
    }),
    // Default read-class throttle (100/min). Tighter per-route classes: auth 10/min
    // (auth.controller.ts), customer/wallet writes 30/min (customers/wallets controllers).
    // `skipIf` lets integration tests disable rate-limiting via THROTTLE_DISABLED=1; off in prod
    // (unset), so the rate limit is fully enforced in any real environment.
    //
    // Storage is env-gated (audit D-14): when `REDIS_URL` is set the counters live in
    // Redis (shared across instances behind a load balancer); when unset the built-in in-memory Map
    // storage is used — identical to before, so the app + all tests work WITHOUT Redis.
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null): ThrottlerModuleOptions => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        skipIf: () => process.env.THROTTLE_DISABLED === '1',
        ...(redis ? { storage: new RedisThrottlerStorage(redis) } : {}),
      }),
    }),
    // Daily metric_daily rollup so the dashboard/analytics time-series never freeze (audit M5).
    ScheduleModule.forRoot(),
    RedisModule,
    PrismaModule,
    AuditModule,
    CryptoModule,
    AuthModule,
    PasswordResetModule,
    CatalogModule,
    OperatorModule,
    NotificationModule,
    RbacModule,
    RiskModule,
    TransactionsModule,
    AnalyticsModule,
    CustomersModule,
    WalletsModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Default-deny authentication: JwtAuthGuard runs GLOBALLY so a controller that forgets
    // @UseGuards is not public by accident. Genuinely public routes opt out with @Public()
    // (login/refresh/logout, MFA verify, password reset, health, SSE stream).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // SEC-003: establish the per-request operator-id ALS context (runs after JwtAuthGuard sets
    // request.user, before the response envelope). A passthrough — no response change.
    { provide: APP_INTERCEPTOR, useClass: OperatorContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
