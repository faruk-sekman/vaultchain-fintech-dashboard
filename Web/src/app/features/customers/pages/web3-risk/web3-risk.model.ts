/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Eip1193Provider } from '@core/services/web3.service';

/**
 * Minimal app-wide EIP-1193 typing (spec: "minimal Window.ethereum typing").
 *
 * The Web3Service reads the provider through a local cast as well, so it never
 * hard-depends on this ambient declaration — keeping the service compilable in
 * isolation (e.g. the unit-test program).
 */
declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/**
 * W3C Verifiable Credential preview shape — CONCEPT PREVIEW ONLY.
 *
 * No real cryptographic issuance/verification happens. In production the real
 * flow is issuer (signs) -> holder (stores) -> verifier (checks proof), and no
 * PII is ever written on-chain.
 */
export interface VcPreview {
  '@context': string[];
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    kycVerified: boolean;
  };
}
