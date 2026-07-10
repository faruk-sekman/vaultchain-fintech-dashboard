/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Rule-based screening engine — the default `ScreeningProvider` binding.
 * Deterministic (same address ⇒ same signals/decision), pure/total: no network, no secrets,
 * no keys. Always declares `isSimulated=true`, so its output can never be persisted as a real
 * regulatory decision.
 */
import { Injectable } from '@nestjs/common';
import type { RiskDecision } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { ScreeningProvider, ScreeningRequest, ScreeningResult, ScreeningSignal } from './screening-provider';

@Injectable()
export class SimulatedScreeningProvider implements ScreeningProvider {
  readonly name = 'rule-based-risk-engine';
  readonly isSimulated = true;

  screen(req: ScreeningRequest): Promise<ScreeningResult> {
    const digest = createHash('sha256').update(req.address.toLowerCase()).digest();
    const signals: ScreeningSignal[] = [
      { key: 'sanctionsHit', hit: digest[0] % 16 === 0, severity: 'high' },
      { key: 'mixerExposure', hit: digest[1] % 4 === 0, severity: 'medium' },
      { key: 'highVelocity', hit: digest[2] % 4 === 0, severity: 'medium' },
      { key: 'suspiciousCounterparty', hit: digest[3] % 6 === 0, severity: 'low' },
    ];
    const decision: RiskDecision = signals.some((s) => s.hit && s.severity === 'high')
      ? 'BLOCK'
      : signals.some((s) => s.hit)
        ? 'REVIEW'
        : 'ALLOW';
    return Promise.resolve({ decision, signals, isSimulated: true });
  }
}
