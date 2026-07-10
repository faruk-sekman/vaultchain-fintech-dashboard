/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * The pluggable Web3/AML screening port. A provider declares its own
 * honesty flag (`isSimulated`); the default binding is the rule-based engine. A real vendor
 * (Chainalysis/TRM/Elliptic) is a future class implementing this same port — no schema churn.
 * Read-only / non-custodial: no on-chain writes, no keys.
 */
import type { RiskDecision, RiskSignalSeverity } from '@prisma/client';

export interface ScreeningSignal {
  key: string;
  hit: boolean;
  severity: RiskSignalSeverity;
}

export interface ScreeningRequest {
  address: string; // validated ^0x[0-9a-fA-F]{40}$ before the call
  chainId?: number;
}

export interface ScreeningResult {
  decision: RiskDecision;
  signals: ScreeningSignal[];
  isSimulated: boolean;
  providerRef?: string; // vendor correlation id (absent for the rule-based engine)
}

export interface ScreeningProvider {
  readonly name: string; // 'rule-based-risk-engine' | 'chainalysis' | …
  readonly isSimulated: boolean;
  screen(req: ScreeningRequest): Promise<ScreeningResult>;
}

/** DI token for the bound screening provider. */
export const SCREENING_PROVIDER = Symbol('SCREENING_PROVIDER');
