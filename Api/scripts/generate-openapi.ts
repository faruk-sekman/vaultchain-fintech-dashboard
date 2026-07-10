/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Emits the OpenAPI document (openapi.json) from the in-code @nestjs/swagger metadata — the single
 * contract source the typed client is generated from. Runs in Nest
 * `preview` mode so providers are NOT instantiated (no DB connection / lifecycle hooks needed).
 *
 * Usage: `npm run openapi:generate` (writes openapi.json, then openapi-typescript emits the types).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Placeholder env so eager config validation passes; preview mode never connects to anything.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/openapi-generation-placeholder';
process.env.JWT_ACCESS_SECRET ??= 'openapi-generation-placeholder-secret';
process.env.JWT_REFRESH_SECRET ??= 'openapi-generation-placeholder-secret';

async function main(): Promise<void> {
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    preview: true, // build the route graph without instantiating providers (no DB)
    logger: false,
  });
  app.setGlobalPrefix('api/v1');

  const config = new DocumentBuilder()
    .setTitle('Fintech Dashboard API')
    .setDescription('System-of-record backend (NestJS on Fastify + Prisma + PostgreSQL).')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = join(__dirname, '..', 'openapi.json');
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`openapi.json written (${Object.keys(document.paths ?? {}).length} paths).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
