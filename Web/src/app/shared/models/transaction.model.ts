/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

export type TransactionType = 'DEBIT' | 'CREDIT';
export type TransferDirection = 'INCOMING' | 'OUTGOING';

// The real backend ledger dimensions (Prisma `TransactionKind` / `TransactionStatus`). These are
// what the backend actually filters on; `type`/`transferDirection` below are FE-derived from the
// signed amount and used only for display (amount colour).
export type TransactionKind =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER'
  | 'FEE'
  | 'ADJUSTMENT'
  | 'REVERSAL';

export type TransactionStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';

export interface Transaction {
  id: string;
  customerId: string;
  kind: TransactionKind;
  status: TransactionStatus;
  type: TransactionType;
  amount: number;
  currency: string;
  createdAt: string;
  description: string;
  transferDirection: TransferDirection;
  merchantName?: string | null;
  receiverName?: string | null;
  receiverWalletNumber?: string | null;
}
