/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Binds the rule-based screening provider to the SCREENING_PROVIDER port (swap the binding for a real
 * vendor later — no schema change). Imports AuthModule for the JWT + permission guards.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { SCREENING_PROVIDER } from './screening/screening-provider';
import { SimulatedScreeningProvider } from './screening/simulated.provider';

@Module({
  imports: [AuthModule],
  controllers: [RiskController],
  providers: [
    RiskService,
    SimulatedScreeningProvider,
    { provide: SCREENING_PROVIDER, useExisting: SimulatedScreeningProvider },
  ],
})
export class RiskModule {}
