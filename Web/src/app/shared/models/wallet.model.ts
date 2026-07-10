/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

export type WalletStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';

export interface Wallet {
  /** Backend wallet id. Required by money-moving POST /transactions. */
  id?: string;
  customerId: string;
  currency: string;
  balance: number;
  dailyLimit: number;
  monthlyLimit: number;
  /** Wallet lifecycle status (backend `GET /customers/:id/wallet`). Optional for legacy callers. */
  status?: WalletStatus;
  /** Optimistic-concurrency token, carried for the future limit-write (C). */
  rowVersion?: number;
}

export interface UpdateWalletLimitsRequest {
  dailyLimit: number;
  monthlyLimit: number;
  /** Optimistic-concurrency token from the last wallet read; mismatch → 409. */
  rowVersion: number;
}
