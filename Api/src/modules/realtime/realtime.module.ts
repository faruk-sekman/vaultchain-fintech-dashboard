/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Realtime (SSE) module. Imports AuthModule for the JwtService (token mint/verify) + the reusable
 * JwtAuthGuard/PermissionsGuard. Exports RealtimeService so write services (e.g. CustomersService)
 * can publish committed mutations to connected dashboards.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';
import { StreamTokenGuard } from './stream-token.guard';

@Module({
  imports: [AuthModule],
  controllers: [RealtimeController],
  providers: [RealtimeService, StreamTokenGuard],
  exports: [RealtimeService],
})
export class RealtimeModule {}
