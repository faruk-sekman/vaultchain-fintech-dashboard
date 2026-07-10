/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Global audit module — exposes the chained AuditService to every feature module.
 */
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
