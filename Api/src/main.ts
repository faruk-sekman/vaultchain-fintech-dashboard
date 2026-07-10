/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Fastify bootstrap: Helmet security headers, a strict global ValidationPipe
 * (whitelist + forbid unknown props — mass-assignment defense), structured pino logging,
 * the `/api/v1` version prefix, and code-first OpenAPI at `/docs`.
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // trustProxy: behind a load balancer / reverse proxy, derive the real client IP from a TRUSTED
  // X-Forwarded-For so per-IP throttling and the audited ipHash reflect the client, not the proxy.
  // Off by default (no proxy assumed); set TRUST_PROXY per environment — `true`, a hop count
  // (e.g. `1`), or a CIDR / comma-separated trusted-proxy list. Never trust all hops on the open net.
  const trustProxyEnv = process.env.TRUST_PROXY?.trim();
  const trustProxy = !trustProxyEnv
    ? false
    : trustProxyEnv === 'true'
      ? true
      : /^\d+$/.test(trustProxyEnv)
        ? Number(trustProxyEnv)
        : trustProxyEnv;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  // Explicit, deliberate security headers for a JSON-only API surface (the Swagger UI is disabled),
  // rather than helmet's implicit defaults: a locked-down CSP (nothing renders from this origin)
  // plus HSTS in production (HTTPS-only). See audit O-9.
  const isProduction = process.env.NODE_ENV === 'production';
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
  // The refresh token rides in an httpOnly cookie; @fastify/cookie parses the
  // inbound Cookie header and adds reply.setCookie/clearCookie. Register before listen.
  await app.register(fastifyCookie);
  // Restrictive CORS for the browser SPA (different origin than the API). Specific origins only —
  // never `*`. Override the allowlist with CORS_ORIGINS (comma-separated) per environment.
  // `credentials: true` is required so the browser sends the httpOnly refresh cookie cross-origin;
  // it is only safe because the origin allowlist below is specific (never `*`).
  // Audit (security): don't fall back to localhost SILENTLY — a real deployment with CORS_ORIGINS
  // unset is a misconfiguration, so make it loud instead of quietly trusting dev origins.
  const corsOriginsEnv = process.env.CORS_ORIGINS?.trim();
  if (!corsOriginsEnv) {
    // eslint-disable-next-line no-console
    console.warn(
      '[bootstrap] CORS_ORIGINS is not set — falling back to localhost dev origins. ' +
        'Set CORS_ORIGINS explicitly per environment.',
    );
  }
  app.enableCors({
    origin: (corsOriginsEnv ?? 'http://localhost:4200,http://localhost:4201').split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    credentials: true,
    maxAge: 600,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('Fintech Dashboard API')
    .setDescription('System-of-record backend (NestJS on Fastify + Prisma + PostgreSQL).')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  // Serve the OpenAPI JSON at /api/v1/docs-json. The interactive Swagger UI is disabled because it
  // requires `@fastify/static` (a dependency we don't add without approval); the contract is also
  // generated offline via `npm run openapi:generate`. Enable the UI by installing
  // @fastify/static and setting swaggerUiEnabled: true.
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
    swaggerUiEnabled: false,
    jsonDocumentUrl: 'docs-json',
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  await app.listen({ port, host: '0.0.0.0' });
}

void bootstrap();
