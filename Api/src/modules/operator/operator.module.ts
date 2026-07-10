/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';

@Module({
  imports: [AuthModule],
  controllers: [OperatorController],
  providers: [OperatorService],
})
export class OperatorModule {}
