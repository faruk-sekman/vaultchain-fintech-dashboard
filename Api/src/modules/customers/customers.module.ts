/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer read module. PrismaModule is global, so only the controller + service
 * are wired here. Writes (POST/PUT/DELETE) and wallet/transaction-list land in follow-up slices.
 * Imports NotificationModule so a KYC-status change can fan a (preference-gated,
 * PII-free) CUSTOMER/KYC notification out to operators.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationModule } from '../notification/notification.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  // AuthModule: JwtAuthGuard + PermissionsGuard; RealtimeModule: RealtimeService (SSE emit);
  // NotificationModule: NotificationService (preference-gated KYC notification fan-out).
  imports: [AuthModule, RealtimeModule, NotificationModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
