/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

/**
 * Single source of truth for the API version segment. The same constant is declared
 * identically in environment.ts / environment.stage.ts / environment.prod.ts so that every
 * environment composes `apiBaseUrl` the same way. Env files are mutually exclusive (Angular
 * fileReplacements swap one in at build time), so the constant is duplicated by literal rather
 * than imported — keep all three in sync if this value ever changes.
 */
export const API_VERSION_PATH = '/api/v1';

/** Composes the full API base from a host origin + the shared version segment. */
function buildApiBaseUrl(host: string): string {
  return `${host.replace(/\/+$/, '')}${API_VERSION_PATH}`;
}

const API_HOST = 'http://localhost:3000';

/**
 * Dev's local API serves under `/api/v1`, so the version prefix is included.
 * Effective `apiBaseUrl`: http://localhost:3000/api/v1 — unchanged from before.
 * stage/prod default this to `false` pending operator confirmation of the remote routing.
 */
const API_INCLUDES_VERSION_PREFIX = true;

export const environment = {
  production: false,
  // Developer-diagnostics gate (re-audit op-stage-devtools): enables NgRx store-devtools + verbose
  // LoggerService console output. TRUE only for local dev; stage + prod set it false so a deployed
  // build never ships devtools/verbose logging even while `production` stays false for source maps.
  enableDevtools: true,
  apiBaseUrl: API_INCLUDES_VERSION_PREFIX ? buildApiBaseUrl(API_HOST) : API_HOST,
  defaultLanguage: 'tr',
  web3: {
    // Public, key-free Ethereum mainnet RPC (swap via env). Real on-chain reads.
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    explorerBaseUrl: 'https://etherscan.io',
    // Empty -> "last seen tx" is simulated. Set a key to fetch a real txlist.
    etherscanApiKey: '',
  },
};
