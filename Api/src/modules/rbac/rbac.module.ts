/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';

@Module({
  imports: [AuthModule], // provides JwtAuthGuard + PermissionsGuard
  controllers: [RbacController],
  providers: [RbacService],
})
export class RbacModule {}
