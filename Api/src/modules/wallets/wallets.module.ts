/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer wallet read module. Imports AuthModule for the JWT + permission guards.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletsController],
  providers: [WalletsService],
})
export class WalletsModule {}
