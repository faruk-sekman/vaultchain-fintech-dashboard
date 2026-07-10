/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Global Prisma module — exposes a single PrismaService to feature modules.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
