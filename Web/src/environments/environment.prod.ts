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

const API_HOST = '';

/**
 * Prod uses the same origin as the frontend deployment. This prevents calls to a third-party/demo
 * API host; only the configured Web3 RPC/explorer URLs are external by design.
 */
const API_INCLUDES_VERSION_PREFIX = true;

export const environment = {
  production: true,
  // Deployed build: no devtools / verbose logging (re-audit op-stage-devtools). See environment.ts.
  enableDevtools: false,
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
