/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomerTransactionsController } from './customer-transactions.controller';
import { CustomerTransactionsService } from './customer-transactions.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [AuthModule], // provides JwtAuthGuard + PermissionsGuard
  controllers: [TransactionsController, CustomerTransactionsController],
  providers: [TransactionsService, CustomerTransactionsService],
})
export class TransactionsModule {}
