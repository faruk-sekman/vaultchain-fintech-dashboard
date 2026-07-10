/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

// The real backend KYC enum (Prisma `KycStatus`) — used end-to-end, no FE collapsing,
// so the list badge, the filter, the detail and the edit form all speak the same 6 values the
// backend stores and filters on.
export type KycStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED';

export interface Address {
  country: string;
  city: string;
  postalCode: string;
  line1: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  walletNumber: string;
  dateOfBirth: string;
  // Masked/padded last-4 of the national id as returned by the backend (`nationalIdLast4`). Kept a
  // STRING so a leading zero (e.g. '0930') survives — coercing to number would render it as 930.
  nationalId: string;
  address: Address;
  kycStatus: KycStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency token from the detail read; sent back on update (mismatch → 409). */
  rowVersion?: number;
}

export interface CreateCustomerRequest {
  name: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  nationalId: string; // TC Kimlik No is a string identifier, never a JS number (re-audit fn-nationalid-number-cast)
  address: Address;
}

export interface UpdateCustomerRequest {
  // name/email/phone are masked on read, so the form sends each ONLY when the operator changed it
  // (omitted = backend preserves the stored value — a masked value must never round-trip back).
  name?: string;
  email?: string;
  phone?: string;
  dateOfBirth: string;
  nationalId: string; // TC Kimlik No is a string identifier, never a JS number (re-audit fn-nationalid-number-cast)
  address: Address;
  // Likewise optional so the lossy 3-value KYC / active controls only overwrite the backend's
  // richer state when the operator actually changed them.
  kycStatus?: KycStatus;
  isActive?: boolean;
  rowVersion: number;
}
