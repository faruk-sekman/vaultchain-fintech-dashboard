/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { of, lastValueFrom } from 'rxjs';

import {
  Web3Service,
  RiskSignal,
  RiskSignalKey,
  RiskAssessmentRecord,
} from '@core/services/web3.service';
import { environment } from '../../../environments/environment';

/** Minimal HttpClient stand-in (mirrors api-client.service.spec style). */
function httpReturning(value: unknown) {
  return {
    get: vi.fn((_url: string) => of(value)),
    post: vi.fn((_url: string, _body: unknown) => of(value)),
  };
}

/** Builds a full signal set with only the requested keys flagged. */
function makeSignals(flagged: Partial<Record<RiskSignalKey, boolean>>): RiskSignal[] {
  return [
    { key: 'mixerExposure', hit: !!flagged.mixerExposure, severity: 'medium' },
    { key: 'highVelocity', hit: !!flagged.highVelocity, severity: 'medium' },
    { key: 'suspiciousCounterparty', hit: !!flagged.suspiciousCounterparty, severity: 'low' },
    { key: 'sanctionsHit', hit: !!flagged.sanctionsHit, severity: 'high' },
  ];
}

const SEED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('Web3Service', () => {
  const make = () => new Web3Service(httpReturning({ result: '0x' }) as never);

  describe('formatUnits (wei -> ETH, by hand with BigInt)', () => {
    it('treats empty / 0x / 0x0 as zero', () => {
      const s = make();
      expect(s.formatUnits('')).toBe('0');
      expect(s.formatUnits('0x')).toBe('0');
      expect(s.formatUnits('0x0')).toBe('0');
    });

    it('converts whole and fractional ETH values', () => {
      const s = make();
      expect(s.formatUnits('0xde0b6b3a7640000')).toBe('1'); // 1e18
      expect(s.formatUnits('0x1bc16d674ec80000')).toBe('2'); // 2e18
      expect(s.formatUnits('0x6f05b59d3b20000')).toBe('0.5'); // 5e17
      expect(s.formatUnits('0x16345785d8a0000')).toBe('0.1'); // 1e17
      expect(s.formatUnits('0x152d02c7e14af6800000')).toBe('100000'); // 1e23
    });

    it('formats gwei with 9 decimals', () => {
      expect(make().formatUnits('0x4a817c800', 9, 2)).toBe('20');
    });

    it('returns 0 for un-parseable input', () => {
      expect(make().formatUnits('not-a-hex')).toBe('0');
    });

    it('handles negative values and precision trimming', () => {
      const s = make();
      expect(s.formatUnits('-1000000000000000000')).toBe('-1');
      expect(s.formatUnits('0x1', 18, 0)).toBe('0');
    });
  });

  describe('hexToNumber', () => {
    it('parses hex and defaults blanks to 0', () => {
      const s = make();
      expect(s.hexToNumber('0x10')).toBe(16);
      expect(s.hexToNumber('0x2a')).toBe(42);
      expect(s.hexToNumber('0x')).toBe(0);
      expect(s.hexToNumber('')).toBe(0);
      expect(s.hexToNumber('not-a-hex')).toBe(0);
    });

    it('returns 0 for a value beyond the safe integer range instead of truncating (SECW-003)', () => {
      // 0xffff…ff (64 f's) = 2^256-1, far above Number.MAX_SAFE_INTEGER — a hostile RPC nonce/count.
      expect(make().hexToNumber('0x' + 'f'.repeat(64))).toBe(0);
    });
  });

  describe('on-chain read address validation (SECW-004)', () => {
    it('rejects a malformed address at the service boundary without issuing any RPC', async () => {
      const http = { post: vi.fn() };
      const s = new Web3Service(http as never);
      await expect(lastValueFrom(s.getBalance('0xabc'))).rejects.toThrow(/invalid address/);
      await expect(lastValueFrom(s.getTransactionCount('0xabc'))).rejects.toThrow(
        /invalid address/,
      );
      await expect(lastValueFrom(s.getCode('0xabc'))).rejects.toThrow(/invalid address/);
      await expect(lastValueFrom(s.getOnChainFacts('not-an-address'))).rejects.toThrow(
        /invalid address/,
      );
      expect(http.post).not.toHaveBeenCalled();
    });
  });

  describe('isValidAddress', () => {
    it('accepts 20-byte hex and rejects malformed input', () => {
      const s = make();
      expect(s.isValidAddress(SEED)).toBe(true);
      expect(s.isValidAddress('0x123')).toBe(false);
      expect(s.isValidAddress('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false);
      expect(s.isValidAddress('0xZZ35Cc6634C0532925a3b844Bc454e4438f44eAA')).toBe(false);
    });
  });

  describe('assessRisk (deterministic policy)', () => {
    it('sanctions hit -> BLOCK', () => {
      const r = make().assessRisk({}, makeSignals({ sanctionsHit: true }));
      expect(r.decision).toBe('BLOCK');
      expect(r.level).toBe('high');
    });

    it('mixer or high velocity or suspicious counterparty -> REVIEW', () => {
      const s = make();
      expect(s.assessRisk({}, makeSignals({ mixerExposure: true })).decision).toBe('REVIEW');
      expect(s.assessRisk({}, makeSignals({ highVelocity: true })).decision).toBe('REVIEW');
      expect(s.assessRisk({}, makeSignals({ suspiciousCounterparty: true })).decision).toBe(
        'REVIEW',
      );
    });

    it('no flagged signals -> ALLOW', () => {
      const r = make().assessRisk({ isContract: false, txCount: 5 }, makeSignals({}));
      expect(r.decision).toBe('ALLOW');
      expect(r.level).toBe('low');
    });
  });

  describe('simulatedLastTxHash', () => {
    it('produces a deterministic 32-byte hex hash', () => {
      const s = make();
      const hash = s.simulatedLastTxHash(SEED);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(s.simulatedLastTxHash(SEED)).toBe(hash);
    });
  });

  describe('deriveScreeningAddress', () => {
    it('derives a stable 20-byte screening address from customer data', () => {
      const s = make();
      const address = s.deriveScreeningAddress('TR1234567890123456');
      expect(address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(s.deriveScreeningAddress('TR1234567890123456')).toBe(address);
      expect(s.deriveScreeningAddress('TR9999999999999999')).not.toBe(address);
    });
  });

  describe('chain metadata + explorer links', () => {
    it('reads chain meta from environment', () => {
      const meta = make().chainMeta();
      expect(meta.chainId).toBe(environment.web3.chainId);
      expect(meta.chainName).toBe(environment.web3.chainName);
    });

    it('builds explorer deep-links', () => {
      const s = make();
      expect(s.explorerAddressUrl('0xabc')).toBe(
        `${environment.web3.explorerBaseUrl}/address/0xabc`,
      );
      expect(s.explorerTxUrl('0xdef')).toBe(`${environment.web3.explorerBaseUrl}/tx/0xdef`);
    });
  });

  describe('EIP-1193 wallet (no provider in test env)', () => {
    it('reports no wallet and a no-op cleanup', () => {
      const s = make();
      expect(s.hasWallet()).toBe(false);
      const off = s.onWalletEvents({
        onAccountsChanged: () => undefined,
        onChainChanged: () => undefined,
      });
      expect(typeof off).toBe('function');
      off();
    });

    it('returns a no-op cleanup when provider events are incomplete', () => {
      const provider = {
        request: vi.fn(),
        on: vi.fn(),
      };
      const previous = window.ethereum;
      window.ethereum = provider as any;
      try {
        const off = make().onWalletEvents({
          onAccountsChanged: () => undefined,
          onChainChanged: () => undefined,
        });
        off();
        expect(provider.on).not.toHaveBeenCalled();
      } finally {
        window.ethereum = previous;
      }
    });

    it('connectWallet rejects with a typed no-wallet error', async () => {
      await expect(make().connectWallet()).rejects.toMatchObject({ message: 'no-wallet' });
    });

    it('personalSign rejects with a typed no-wallet error', async () => {
      await expect(make().personalSign('0xabc', 'audit')).rejects.toMatchObject({
        message: 'no-wallet',
      });
    });

    it('connectWallet returns an empty address when provider has no accounts', async () => {
      const provider = {
        request: vi.fn(async (args: { method: string }) => {
          if (args.method === 'eth_requestAccounts') return [];
          if (args.method === 'eth_chainId') return '0x1';
          return null;
        }),
      };
      const previous = window.ethereum;
      window.ethereum = provider as any;
      try {
        await expect(make().connectWallet()).resolves.toEqual({ address: '', chainIdHex: '0x1' });
      } finally {
        window.ethereum = previous;
      }
    });
  });

  describe('JSON-RPC reads (HttpClient)', () => {
    it('eth_getBalance posts a JSON-RPC envelope and returns the hex result', async () => {
      const http = httpReturning({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' });
      const s = new Web3Service(http as never);
      const result = await lastValueFrom(s.getBalance(SEED));
      expect(result).toBe('0xde0b6b3a7640000');
      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe(environment.web3.rpcUrl);
      expect(body).toMatchObject({ jsonrpc: '2.0', method: 'eth_getBalance' });
    });

    it('throws on a JSON-RPC error body (HTTP 200 with error)', async () => {
      const http = httpReturning({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'bad request' },
      });
      const s = new Web3Service(http as never);
      await expect(lastValueFrom(s.getBalance(SEED))).rejects.toThrow(/bad request/);
    });

    it('throws when the RPC returns neither result nor error', async () => {
      const http = httpReturning({ jsonrpc: '2.0', id: 1 });
      const s = new Web3Service(http as never);
      await expect(lastValueFrom(s.getBalance(SEED))).rejects.toThrow(/no result/);
    });

    it('getOnChainFacts maps balance, nonce and EOA vs contract', async () => {
      const http = {
        post: vi.fn((_url: string, body: { method: string }) => {
          if (body.method === 'eth_getBalance') return of({ result: '0xde0b6b3a7640000' });
          if (body.method === 'eth_getTransactionCount') return of({ result: '0x2a' });
          if (body.method === 'eth_getCode') return of({ result: '0x' });
          return of({ result: '0x0' });
        }),
      };
      const facts = await lastValueFrom(new Web3Service(http as never).getOnChainFacts(SEED));
      expect(facts.balanceEth).toBe('1');
      expect(facts.txCount).toBe(42);
      expect(facts.isContract).toBe(false);
    });

    it('getOnChainFacts fails only when every read fails logically', async () => {
      const http = {
        post: vi.fn(() => of({ error: { code: -32000, message: 'rpc fail' } })),
      };
      await expect(
        lastValueFrom(new Web3Service(http as never).getOnChainFacts(SEED)),
      ).rejects.toThrow(/All on-chain reads failed/);
    });

    it('getOnChainFacts keeps partial facts when only some reads fail', async () => {
      const http = {
        post: vi.fn((_url: string, body: { method: string }) => {
          if (body.method === 'eth_getBalance') {
            return of({ error: { code: -32000, message: 'balance fail' } });
          }
          if (body.method === 'eth_getTransactionCount') return of({ result: '0x2a' });
          if (body.method === 'eth_getCode') {
            return of({ error: { code: -32000, message: 'code fail' } });
          }
          return of({ result: '0x0' });
        }),
      };

      const partial = await lastValueFrom(new Web3Service(http as never).getOnChainFacts(SEED));

      expect(partial.balanceWei).toBeNull();
      expect(partial.balanceEth).toBeNull();
      expect(partial.txCount).toBe(42);
      expect(partial.isContract).toBeNull();
    });

    it('getNetworkInfo maps chainId, block and gas price', async () => {
      const http = {
        post: vi.fn((_url: string, body: { method: string }) => {
          if (body.method === 'eth_chainId') return of({ result: '0x1' });
          if (body.method === 'eth_blockNumber') return of({ result: '0x10' });
          if (body.method === 'eth_gasPrice') return of({ result: '0x4a817c800' });
          return of({ result: '0x0' });
        }),
      };
      const info = await lastValueFrom(new Web3Service(http as never).getNetworkInfo());
      expect(info.chainId).toBe(1);
      expect(info.blockNumber).toBe(16);
      expect(info.gasPriceGwei).toBe('20');
    });
  });

  describe('EIP-1193 wallet (with an injected provider)', () => {
    it('connects, signs, and wires up + tears down events', async () => {
      const provider = {
        request: vi.fn(async (args: { method: string }) => {
          if (args.method === 'eth_requestAccounts')
            return ['0xAbC0000000000000000000000000000000000001'];
          if (args.method === 'eth_chainId') return '0x1';
          if (args.method === 'personal_sign') return '0xsignature';
          return null;
        }),
        on: vi.fn(),
        removeListener: vi.fn(),
      };
      const g = globalThis as unknown as { window?: { ethereum?: unknown } };
      const hadWindow = !!g.window;
      g.window = g.window ?? {};
      g.window.ethereum = provider;
      try {
        const s = make();
        expect(s.hasWallet()).toBe(true);

        const op = await s.connectWallet();
        expect(op.address).toBe('0xAbC0000000000000000000000000000000000001');
        expect(op.chainIdHex).toBe('0x1');

        expect(await s.personalSign(op.address, 'audit')).toBe('0xsignature');

        const off = s.onWalletEvents({
          onAccountsChanged: accounts => {
            expect(accounts).toEqual([]);
          },
          onChainChanged: chainIdHex => {
            expect(chainIdHex).toBe('0x');
          },
        });
        expect(provider.on).toHaveBeenCalledWith('accountsChanged', expect.any(Function));
        const accountsHandler = provider.on.mock.calls.find(
          call => call[0] === 'accountsChanged',
        )?.[1];
        const chainHandler = provider.on.mock.calls.find(call => call[0] === 'chainChanged')?.[1];
        expect(accountsHandler).toBeTypeOf('function');
        expect(chainHandler).toBeTypeOf('function');
        accountsHandler?.();
        chainHandler?.();
        off();
        expect(provider.removeListener).toHaveBeenCalled();
      } finally {
        if (hadWindow) {
          delete g.window!.ethereum;
        } else {
          delete g.window;
        }
      }
    });
  });

  describe('recordDecision (backend persistence)', () => {
    const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
    const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    const persisted: RiskAssessmentRecord = {
      id: 'a1',
      customerId: CUSTOMER_ID,
      address: ADDRESS,
      decision: 'BLOCK',
      isSimulated: true,
      providerName: 'rule-based-risk-engine',
      createdAt: '2026-06-09T00:00:00Z',
      signals: makeSignals({ sanctionsHit: true }),
    };

    it('POSTs to the API base (not the RPC node) with isSimulated:true + mapped enum', async () => {
      const http = httpReturning({ data: persisted });
      const s = new Web3Service(http as never);
      const signals = makeSignals({ sanctionsHit: true });

      const result = await lastValueFrom(
        s.recordDecision(CUSTOMER_ID, {
          address: ADDRESS,
          decision: 'BLOCK',
          isSimulated: true,
          signals,
        }),
      );

      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe(`${environment.apiBaseUrl}/customers/${CUSTOMER_ID}/risk-decisions`);
      expect(url).not.toContain(environment.web3.rpcUrl);
      expect(body).toEqual({
        address: ADDRESS,
        decision: 'BLOCK',
        isSimulated: true,
        signals,
      });
      // Unwraps the global `{ data }` envelope to the typed record.
      expect(result.isSimulated).toBe(true);
      expect(result.decision).toBe('BLOCK');
    });

    it('screens risk through the backend API and unwraps the response', async () => {
      const http = httpReturning({
        data: {
          address: ADDRESS,
          decision: 'REVIEW',
          isSimulated: true,
          providerName: 'rule-based-risk-engine',
          signals: makeSignals({ mixerExposure: true }),
        },
      });
      const s = new Web3Service(http as never);

      const result = await lastValueFrom(s.screenRisk(CUSTOMER_ID, ADDRESS));

      expect(http.post).toHaveBeenCalledWith(
        `${environment.apiBaseUrl}/customers/${CUSTOMER_ID}/risk-screenings`,
        { address: ADDRESS },
      );
      expect(result.decision).toBe('REVIEW');
      expect(result.providerName).toBe('rule-based-risk-engine');
    });

    it('lists persisted risk assessments (paginated envelope) from the backend API', async () => {
      // Server-side `{ data, page }` envelope (was `{ data: { items } }`).
      const http = httpReturning({
        data: [persisted],
        page: { number: 1, size: 25, totalItems: 1, totalPages: 1 },
      });
      const s = new Web3Service(http as never);

      const result = await lastValueFrom(s.listRiskAssessments(CUSTOMER_ID));

      expect(http.get).toHaveBeenCalledWith(
        `${environment.apiBaseUrl}/customers/${CUSTOMER_ID}/risk-assessments`,
        expect.anything(),
      );
      expect(result.data).toEqual([persisted]);
      expect(result.total).toBe(1);
    });

    it('forwards page[number] + page[size] when paging params are provided (HttpParams branches)', async () => {
      const http = httpReturning({
        data: [],
        page: { number: 2, size: 10, totalItems: 0, totalPages: 0 },
      });
      const s = new Web3Service(http as never);

      await lastValueFrom(s.listRiskAssessments(CUSTOMER_ID, { page: 2, pageSize: 10 }));

      const params = http.get.mock.calls[0][1].params;
      expect(params.get('page[number]')).toBe('2');
      expect(params.get('page[size]')).toBe('10');
    });
  });

  describe('getOnChainFacts — per-read resilience (orNull / nullable mappers)', () => {
    /** An http stub whose `post` (the JSON-RPC transport) resolves per method via the map. */
    function rpcRouter(byMethod: Record<string, unknown>) {
      return {
        get: vi.fn(),
        post: vi.fn((_url: string, body: { method: string }) =>
          of(byMethod[body.method] ?? { result: '0x' }),
        ),
      };
    }

    it('keeps the surviving reads and nulls the failed one (mixed success)', async () => {
      // balance OK, txCount is a logical RPC error (→ null via orNull), code = contract bytecode.
      const http = rpcRouter({
        eth_getBalance: { result: '0xde0b6b3a7640000' }, // 1 ETH
        eth_getTransactionCount: { error: { code: -32000, message: 'rate limited' } },
        eth_getCode: { result: '0x60016002' }, // non-empty → contract
      });
      const s = new Web3Service(http as never);

      const facts = await lastValueFrom(s.getOnChainFacts(SEED));
      expect(facts.balanceWei).toBe('0xde0b6b3a7640000');
      expect(facts.balanceEth).toBe('1');
      expect(facts.txCount).toBeNull(); // failed read → null (hexToNullableNumber null branch)
      expect(facts.isContract).toBe(true); // bytecode present (isNullableContractCode non-null branch)
    }, 10000);

    it('reports an EOA (code === "0x") as a non-contract with a real txCount', async () => {
      const http = rpcRouter({
        eth_getBalance: { result: '0x0' },
        eth_getTransactionCount: { result: '0x5' },
        eth_getCode: { result: '0x' }, // EOA
      });
      const s = new Web3Service(http as never);

      const facts = await lastValueFrom(s.getOnChainFacts(SEED));
      expect(facts.isContract).toBe(false); // '0x' → not a contract (the `code !== '0x'` branch)
      expect(facts.txCount).toBe(5);
    }, 10000);

    it('throws only when EVERY read fails (all three null)', async () => {
      const http = rpcRouter({
        eth_getBalance: { error: { code: -1, message: 'x' } },
        eth_getTransactionCount: { error: { code: -1, message: 'x' } },
        eth_getCode: { error: { code: -1, message: 'x' } },
      });
      const s = new Web3Service(http as never);

      await expect(lastValueFrom(s.getOnChainFacts(SEED))).rejects.toThrow(
        /All on-chain reads failed/,
      );
    }, 10000);
  });

  describe('deriveScreeningAddress — seed normalisation (hashAddress null-seed branch)', () => {
    it('produces a valid 20-byte address and falls back to the default seed for an empty input', () => {
      const s = make();
      const derived = s.deriveScreeningAddress('');
      expect(s.isValidAddress(derived)).toBe(true);
      // The empty input falls back to the documented default seed, so the result is deterministic.
      expect(derived).toBe(s.deriveScreeningAddress('customer-risk-seed'));
    });
  });

  describe("pure-helper null-guards (the `?? ''` defensive branches)", () => {
    it('isValidAddress treats a null/undefined input as the empty string (invalid)', () => {
      const s = make();
      expect(s.isValidAddress(null as unknown as string)).toBe(false);
      expect(s.isValidAddress(undefined as unknown as string)).toBe(false);
    });

    it('formatUnits / hexToNumber coerce a null input to 0', () => {
      const s = make();
      expect(s.formatUnits(null as unknown as string)).toBe('0');
      expect(s.hexToNumber(null as unknown as string)).toBe(0);
    });

    it('deriveScreeningAddress accepts a null seed via the default-seed fallback', () => {
      const s = make();
      // `null` is falsy → the `seed || 'customer-risk-seed'` fallback feeds hashAddress a real string.
      const derived = s.deriveScreeningAddress(null as unknown as string);
      expect(s.isValidAddress(derived)).toBe(true);
    });
  });
});
