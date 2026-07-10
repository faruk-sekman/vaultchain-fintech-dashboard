/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { CredentialPreview, CustomersApi } from '@core/api/customers.api';
import { AuthService } from '@core/auth/auth.service';
import {
  ChainMeta,
  NetworkInfo,
  OnChainFacts,
  OperatorWallet,
  RiskAssessment,
  RiskAssessmentRecord,
  RiskDecision,
  RiskScreeningResult,
  RiskSignal,
  Web3Service,
} from '@core/services/web3.service';
import { ToastService } from '@core/services/toast.service';
import { Customer } from '@shared/models/customer.model';
import { Web3RiskComponent } from './web3-risk.component';

const SAMPLE_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const NEXT_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const DERIVED_ADDRESS = '0x1111111111111111111111111111111111111111';

const customer: Customer = {
  id: 'cust-1',
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+905551112233',
  walletNumber: '1234567890123456',
  dateOfBirth: '1990-01-01',
  nationalId: '10000000146',
  address: {
    country: 'TR',
    city: 'Istanbul',
    postalCode: '34000',
    line1: 'Compliance Street',
  },
  kycStatus: 'VERIFIED',
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const chain: ChainMeta = {
  chainId: 1,
  chainName: 'Ethereum',
  explorerBaseUrl: 'https://etherscan.example',
};

const facts: OnChainFacts = {
  address: SAMPLE_ADDRESS,
  balanceWei: '0xde0b6b3a7640000',
  balanceEth: '1',
  txCount: 42,
  isContract: false,
};

const network: NetworkInfo = {
  chainId: 1,
  chainIdHex: '0x1',
  blockNumber: 123,
  gasPriceWei: '0x4a817c800',
  gasPriceGwei: '20',
};

const signals: RiskSignal[] = [
  { key: 'mixerExposure', hit: true, severity: 'medium' },
  { key: 'highVelocity', hit: false, severity: 'medium' },
  { key: 'suspiciousCounterparty', hit: false, severity: 'low' },
  { key: 'sanctionsHit', hit: false, severity: 'high' },
];

const clearSignals: RiskSignal[] = signals.map(signal => ({ ...signal, hit: false }));

const persistedRecord: RiskAssessmentRecord = {
  id: 'rec-1',
  customerId: customer.id,
  address: SAMPLE_ADDRESS,
  decision: 'BLOCK',
  isSimulated: true,
  providerName: 'rule-based-risk-engine',
  createdAt: '2026-06-09T00:00:00Z',
  signals,
};

function assessmentFor(decision: RiskDecision, level: RiskAssessment['level']): RiskAssessment {
  return { decision, level, signals };
}

function setup(
  options: {
    customerResult?: Observable<Customer>;
    credentialResult?: Observable<CredentialPreview>;
    factsResult?: Observable<OnChainFacts>;
    networkResult?: Observable<NetworkInfo>;
    hasWallet?: boolean;
    validAddress?: boolean;
    connectWallet?: () => Promise<OperatorWallet>;
    personalSign?: () => Promise<string>;
    onWalletEvents?: Web3Service['onWalletEvents'];
    screenRiskResult?: Observable<RiskScreeningResult>;
    /** Persistence result for record(); defaults to a successful 201 record. */
    recordResult?: Observable<RiskAssessmentRecord>;
    /** Granted permission codes for the stub AuthService; defaults to the decision gate. */
    permissions?: string[];
  } = {},
) {
  TestBed.resetTestingModule();

  const routeParamMap = new BehaviorSubject(convertToParamMap({ id: customer.id }));
  const route = { paramMap: routeParamMap.asObservable() };
  const router = { navigate: vi.fn() };
  const customersApi = {
    getById: vi.fn(() => options.customerResult ?? of(customer)),
    getCredentialPreview: vi.fn(
      () =>
        options.credentialResult ??
        of({
          '@context': ['https://www.w3.org/2018/credentials/v1'],
          type: ['VerifiableCredential', 'KycCredential'],
          issuer: 'did:example:fintech-ops-compliance',
          issuanceDate: '2026-06-12T00:00:00.000Z',
          credentialSubject: {
            id: `did:example:${customer.id}`,
            kycVerified: true,
          },
        }),
    ),
  };
  const toast = {
    error: vi.fn(),
    success: vi.fn(),
  };
  const i18n = {
    instant: vi.fn((key: string, params?: Record<string, unknown>) => {
      if (key === 'web3.explanation.template') {
        return `count:${params?.['count']} list:${params?.['list']} decision:${params?.['decision']}`;
      }
      return `t:${key}`;
    }),
  };
  const web3 = {
    chainMeta: vi.fn(() => chain),
    hasWallet: vi.fn(() => options.hasWallet ?? true),
    isValidAddress: vi.fn(() => options.validAddress ?? true),
    getOnChainFacts: vi.fn(() => options.factsResult ?? of(facts)),
    screenRisk: vi.fn(
      () =>
        options.screenRiskResult ??
        of({
          address: DERIVED_ADDRESS,
          decision: 'REVIEW',
          isSimulated: true,
          providerName: 'rule-based-risk-engine',
          signals,
        }),
    ),
    deriveScreeningAddress: vi.fn(() => DERIVED_ADDRESS),
    simulatedLastTxHash: vi.fn((address: string) => `0xsimulated-${address.slice(2, 10)}`),
    getNetworkInfo: vi.fn(() => options.networkResult ?? of(network)),
    connectWallet: vi.fn(
      options.connectWallet ??
        (async () => ({ address: SAMPLE_ADDRESS, chainIdHex: '0x1' as const })),
    ),
    onWalletEvents: vi.fn(options.onWalletEvents ?? (() => () => undefined)),
    personalSign: vi.fn(options.personalSign ?? (async () => '0xsigned')),
    explorerAddressUrl: vi.fn((address: string) => `${chain.explorerBaseUrl}/address/${address}`),
    explorerTxUrl: vi.fn((hash: string) => `${chain.explorerBaseUrl}/tx/${hash}`),
    recordDecision: vi.fn(() => options.recordResult ?? of(persistedRecord)),
  };

  const granted = options.permissions ?? ['kyc.manage'];
  const auth = { hasPermission: vi.fn((p: string) => granted.includes(p)) };

  TestBed.configureTestingModule({
    providers: [
      { provide: ActivatedRoute, useValue: route },
      { provide: Router, useValue: router },
      { provide: CustomersApi, useValue: customersApi },
      { provide: Web3Service, useValue: web3 },
      { provide: TranslateService, useValue: i18n },
      { provide: ToastService, useValue: toast },
      { provide: AuthService, useValue: auth },
    ],
  });

  const component = TestBed.runInInjectionContext(() => new Web3RiskComponent());
  return { component, customersApi, i18n, routeParamMap, router, toast, web3, auth };
}

describe('Web3RiskComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads customer and network on init without sending the derived demo address to RPC', () => {
    const { component, customersApi, web3 } = setup();

    component.ngOnInit();

    expect(customersApi.getById).toHaveBeenCalledWith(customer.id);
    expect(customersApi.getCredentialPreview).toHaveBeenCalledWith(customer.id);
    expect(component.customer()).toEqual(customer);
    expect(component.vc()?.credentialSubject.kycVerified).toBe(true);
    expect(component.loadingCustomer()).toBe(false);
    expect(component.network()).toEqual(network);
    expect(component.addressControl.value).toBe(DERIVED_ADDRESS);
    expect(component.facts()).toBeNull();
    expect(component.assessment()).toBeNull();
    expect(component.screening()).toBe(false);
    expect(web3.deriveScreeningAddress).toHaveBeenCalledWith(customer.walletNumber);
    expect(web3.getOnChainFacts).not.toHaveBeenCalled();
    expect(web3.screenRisk).not.toHaveBeenCalled();
  });

  it('(W3-01) flags the screening as derived on auto-prime and clears it for a real address', () => {
    const { component, web3 } = setup();

    component.ngOnInit();

    // Auto-primed: the derived placeholder is visible in the form, but no screening has run yet.
    expect(component.addressControl.value).toBe(DERIVED_ADDRESS);
    expect(component.screenedAddress()).toBe('');
    expect(component.screeningIsDerived()).toBe(false);

    // Operator screens a real, non-derived 0x address -> chip disappears, REAL panel stands.
    web3.deriveScreeningAddress.mockReturnValue(DERIVED_ADDRESS);
    component.addressControl.setValue(SAMPLE_ADDRESS);
    component.screen();

    expect(component.screenedAddress()).toBe(SAMPLE_ADDRESS);
    expect(component.screeningIsDerived()).toBe(false);
  });

  it('(W3-01) derived flag is false with no screened address or no customer', () => {
    const { component } = setup();
    // Nothing screened yet.
    expect(component.screeningIsDerived()).toBe(false);

    // Screened address present but customer not loaded -> still false (guards the computed).
    component.screenedAddress.set(DERIVED_ADDRESS);
    expect(component.screeningIsDerived()).toBe(false);
  });

  it('handles customer and network load failures with safe UI state', () => {
    const { component, toast } = setup({
      customerResult: throwError(() => new Error('not found')),
      networkResult: throwError(() => new Error('network')),
    });

    component.ngOnInit();

    expect(component.customer()).toBeNull();
    expect(component.loadingCustomer()).toBe(false);
    expect(component.network()).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('t:errors.notFound');
  });

  it('rejects malformed addresses before any on-chain read', () => {
    const { component, web3 } = setup({ validAddress: false });
    component.facts.set(facts);
    component.assessment.set(assessmentFor('ALLOW', 'low'));
    component.simSignals.set(signals);
    component.lastTxHash.set('0xabc');
    component.addressControl.setValue('not-an-address');

    component.screen();

    expect(component.addressInvalid()).toBe(true);
    expect(component.facts()).toBeNull();
    expect(component.assessment()).toBeNull();
    expect(component.simSignals()).toEqual([]);
    expect(component.lastTxHash()).toBeNull();
    expect(web3.getOnChainFacts).not.toHaveBeenCalled();
  });

  it('keeps backend screening result when on-chain reads fail', () => {
    const { component, web3 } = setup({
      factsResult: throwError(() => new Error('rpc')),
      screenRiskResult: of({
        address: SAMPLE_ADDRESS,
        decision: 'ALLOW',
        isSimulated: true,
        providerName: 'rule-based-risk-engine',
        signals: clearSignals,
      }),
    });
    component.customer.set(customer);
    component.addressControl.setValue(SAMPLE_ADDRESS);

    component.screen();

    expect(component.factsError()).toBe(true);
    expect(component.screening()).toBe(false);
    expect(component.assessment()?.decision).toBe('ALLOW');
    expect(component.lastTxHash()).toBe(`0xsimulated-${SAMPLE_ADDRESS.slice(2, 10)}`);
    expect(web3.simulatedLastTxHash).toHaveBeenCalledWith(SAMPLE_ADDRESS);
    expect(web3.screenRisk).toHaveBeenCalledWith(customer.id, SAMPLE_ADDRESS);
  });

  it('uses backend screening result with nullable on-chain facts', () => {
    const { component, web3 } = setup({
      factsResult: of({ ...facts, isContract: null, txCount: null }),
      screenRiskResult: of({
        address: SAMPLE_ADDRESS,
        decision: 'BLOCK',
        isSimulated: true,
        providerName: 'rule-based-risk-engine',
        signals,
      }),
    });
    component.customer.set(customer);
    component.addressControl.setValue(SAMPLE_ADDRESS);

    component.screen();

    expect(component.facts()?.isContract).toBeNull();
    expect(component.assessment()?.decision).toBe('BLOCK');
    expect(component.lastTxHash()).toBe(`0xsimulated-${SAMPLE_ADDRESS.slice(2, 10)}`);
    expect(web3.screenRisk).toHaveBeenCalledWith(customer.id, SAMPLE_ADDRESS);
  });

  it('connects wallet, responds to wallet events, and cleans up on destroy', async () => {
    let handlers: Parameters<Web3Service['onWalletEvents']>[0] | null = null;
    const cleanup = vi.fn();
    const { component, web3 } = setup({
      onWalletEvents: incoming => {
        handlers = incoming;
        return cleanup;
      },
    });

    await component.connect();

    expect(component.operator()).toEqual({ address: SAMPLE_ADDRESS, chainIdHex: '0x1' });
    expect(web3.onWalletEvents).toHaveBeenCalled();

    handlers?.onAccountsChanged([NEXT_ADDRESS]);
    expect(component.operator()?.address).toBe(NEXT_ADDRESS);

    handlers?.onChainChanged('0xaa');
    expect(component.operator()?.chainIdHex).toBe('0xaa');

    component.signature.set('0xsigned');
    handlers?.onAccountsChanged([]);
    expect(component.operator()).toBeNull();
    expect(component.signature()).toBeNull();

    handlers?.onAccountsChanged([NEXT_ADDRESS]);
    expect(component.operator()).toBeNull();

    handlers?.onChainChanged('0xbb');
    expect(component.operator()).toBeNull();

    await component.connect();
    component.signature.set('0xsigned');
    component.disconnect();
    expect(component.operator()).toBeNull();
    expect(component.signature()).toBeNull();
    expect(cleanup).toHaveBeenCalled();

    component.ngOnDestroy();
  });

  it('maps wallet connection errors to translated messages', async () => {
    const rejected = setup({ connectWallet: async () => Promise.reject({ code: 4001 }) });
    await rejected.component.connect();
    expect(rejected.component.walletError()).toBe('t:web3.wallet.rejected');

    const missing = setup({
      connectWallet: async () => Promise.reject({ message: 'no-wallet' }),
    });
    await missing.component.connect();
    expect(missing.component.walletError()).toBe('t:web3.wallet.notFound');

    const generic = setup({ connectWallet: async () => Promise.reject(new Error('boom')) });
    await generic.component.connect();
    expect(generic.component.walletError()).toBe('t:web3.wallet.error');
  });

  it('signs optional audit messages and handles sign failures', async () => {
    const ok = setup();
    await ok.component.signAudit();
    expect(ok.web3.personalSign).not.toHaveBeenCalled();

    ok.component.operator.set({ address: SAMPLE_ADDRESS, chainIdHex: '0x1' });
    await ok.component.signAudit();
    expect(ok.web3.personalSign).not.toHaveBeenCalled();

    ok.component.screenedAddress.set(SAMPLE_ADDRESS);
    await ok.component.signAudit();
    expect(ok.component.signature()).toBe('0xsigned');
    expect(ok.web3.personalSign).toHaveBeenCalledWith(SAMPLE_ADDRESS, 't:web3.signMessage');

    const failed = setup({ personalSign: async () => Promise.reject({ code: 4001 }) });
    failed.component.operator.set({ address: SAMPLE_ADDRESS, chainIdHex: '0x1' });
    failed.component.screenedAddress.set(SAMPLE_ADDRESS);
    await failed.component.signAudit();
    expect(failed.component.walletError()).toBe('t:web3.wallet.rejected');
  });

  it('persists the decision (isSimulated:true + mapped enum), then reflects it locally', () => {
    const { component, web3, toast } = setup();
    component.customer.set(customer);
    component.assessment.set(assessmentFor('BLOCK', 'high'));
    component.simSignals.set(signals);
    component.screenedAddress.set(SAMPLE_ADDRESS);

    component.record('BLOCK');

    // POSTs to the audit-logged endpoint with the honesty flag + screening context.
    expect(web3.recordDecision).toHaveBeenCalledWith(customer.id, {
      address: SAMPLE_ADDRESS,
      decision: 'BLOCK',
      isSimulated: true,
      signals,
    });
    // Synchronous `of(...)` success -> the verdict + toast appear.
    expect(component.recommendation()).toBe('BLOCK');
    expect(component.recording()).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('t:web3.record.toast');
  });

  it('does not persist or claim "saved" without a loaded customer', () => {
    const { component, web3 } = setup();
    // customer() is null until the route resolves.
    component.record('ALLOW');
    expect(web3.recordDecision).not.toHaveBeenCalled();
    expect(component.recommendation()).toBeNull();

    component.customer.set(customer);
    component.screenedAddress.set(SAMPLE_ADDRESS);
    component.record('ALLOW');
    expect(web3.recordDecision).not.toHaveBeenCalled();
  });

  it('on persistence failure: no verdict, no success toast (interceptor surfaces the error)', () => {
    const { component, toast } = setup({
      recordResult: throwError(() => ({ status: 403 })),
    });
    component.customer.set(customer);

    component.record('BLOCK');

    expect(component.recommendation()).toBeNull();
    expect(component.recording()).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('navigates back and builds explorer links', () => {
    const { component, router } = setup();

    component.back();
    expect(router.navigate).toHaveBeenCalledWith(['/customers']);

    component.customer.set(customer);
    component.back();
    expect(router.navigate).toHaveBeenCalledWith(['/customers', customer.id]);

    component.screenedAddress.set(SAMPLE_ADDRESS);
    expect(component.addressExplorerUrl()).toContain(SAMPLE_ADDRESS);
    expect(component.txExplorerUrl('0xdef')).toContain('/tx/0xdef');
  });

  it('derives badge colors, explanations, risk level, and VC preview', () => {
    const { component } = setup();

    expect(component.decisionColor('BLOCK')).toBe('red');
    expect(component.decisionColor('REVIEW')).toBe('yellow');
    expect(component.decisionColor('ALLOW')).toBe('green');
    expect(component.decisionColor(null)).toBe('gray');
    expect(component.signalColor(true)).toBe('red');
    expect(component.signalColor(false)).toBe('green');

    component.assessment.set(assessmentFor('BLOCK', 'high'));
    expect(component.levelPercent()).toBe(100);
    expect(component.explanation()).toContain('count:1');

    component.assessment.set(assessmentFor('REVIEW', 'medium'));
    expect(component.levelPercent()).toBe(66);

    component.assessment.set(assessmentFor('ALLOW', 'low'));
    expect(component.levelPercent()).toBe(34);

    component.assessment.set({ decision: 'ALLOW', level: 'low', signals: clearSignals });
    expect(component.explanation()).toContain('t:web3.explanation.none');

    component.assessment.set(null);
    expect(component.levelPercent()).toBe(0);
    expect(component.explanation()).toBe('');

    component.vc.set({
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'KycCredential'],
      issuer: 'did:example:fintech-ops-compliance',
      issuanceDate: '2026-06-12T00:00:00.000Z',
      credentialSubject: { id: `did:example:${customer.id}`, kycVerified: true },
    });
    expect(component.vc()?.credentialSubject.kycVerified).toBe(true);
    expect(component.vcJson()).toContain('KycCredential');

    component.vc.set({
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'KycCredential'],
      issuer: 'did:example:fintech-ops-compliance',
      issuanceDate: '2026-06-12T00:00:00.000Z',
      credentialSubject: { id: `did:example:${customer.id}`, kycVerified: false },
    });
    expect(component.vc()?.credentialSubject.kycVerified).toBe(false);

    component.vc.set(null);
    expect(component.vc()).toBeNull();
    expect(component.vcJson()).toBe('');
  });

  it('gates the compliance decision record action on kyc.manage', () => {
    // Full-permission operator: the record (ALLOW/REVIEW/BLOCK) action is offered.
    const allowed = setup({ permissions: ['kyc.manage'] });
    expect((allowed.component as any).auth.hasPermission('kyc.manage')).toBe(true);

    // Reduced principal (read-only): the record action block is hidden — the template @if is false.
    const denied = setup({ permissions: ['kyc.read'] });
    expect((denied.component as any).auth.hasPermission('kyc.manage')).toBe(false);
  });

  it('derives the risk-level visuals (progress colour + icon + flagged banner) per decision level', () => {
    const { component } = setup();

    // No assessment yet → safe defaults (success family, shield-check icon, no flags).
    expect(component.riskProgressColor()).toBe('success');
    expect(component.riskLevelIcon()).toBe('ri-shield-check-line');
    expect(component.hasFlags()).toBe(false);

    // BLOCK/high → danger family + alarm icon; the seeded signals include a hit → flagged banner on.
    component.assessment.set(assessmentFor('BLOCK', 'high'));
    expect(component.riskProgressColor()).toBe('danger');
    expect(component.riskLevelIcon()).toBe('ri-alarm-warning-line');
    expect(component.hasFlags()).toBe(true);

    // REVIEW/medium → warning family + error-warning icon.
    component.assessment.set(assessmentFor('REVIEW', 'medium'));
    expect(component.riskProgressColor()).toBe('warning');
    expect(component.riskLevelIcon()).toBe('ri-error-warning-line');

    // All-clear signals → no flags fired (the `.some(hit)` false branch).
    component.assessment.set({ decision: 'ALLOW', level: 'low', signals: clearSignals });
    expect(component.hasFlags()).toBe(false);
  });

  it('signalAlertType maps a fired signal to danger and a clear one to success', () => {
    const { component } = setup();
    expect(component.signalAlertType(true)).toBe('danger');
    expect(component.signalAlertType(false)).toBe('success');
  });

  it('canRecord / canSignAudit gate on a loaded customer + assessment + screened address', () => {
    const { component } = setup();
    // Nothing screened yet → both action computeds are false.
    expect(component.canRecord()).toBe(false);
    expect(component.canSignAudit()).toBe(false);

    component.customer.set(customer);
    component.assessment.set(assessmentFor('ALLOW', 'low'));
    component.screenedAddress.set(SAMPLE_ADDRESS);
    // Customer + assessment + address present and not recording → record action enabled.
    expect(component.canRecord()).toBe(true);

    component.operator.set({ address: SAMPLE_ADDRESS, chainIdHex: '0x1' });
    // Operator wallet + screened address → the optional audit-sign action is enabled.
    expect(component.canSignAudit()).toBe(true);

    // While a persistence POST is in flight, canRecord must drop to false (guards double-submit).
    component.recording.set(true);
    expect(component.canRecord()).toBe(false);
  });

  it('screen() bails before any read when the address is valid but no customer is loaded', () => {
    const { component, web3 } = setup();
    // No customer set → the `if (!customer) return` guard fires after the validity check.
    component.addressControl.setValue(SAMPLE_ADDRESS);
    component.screen();
    expect(web3.getOnChainFacts).not.toHaveBeenCalled();
    expect(component.screening()).toBe(false);
    expect(component.screenedAddress()).toBe('');
  });

  it('screen() resets to a safe empty state when the combined screening stream errors', () => {
    const { component } = setup({
      // forkJoin errors when the risk source throws (the facts source has its own catchError).
      screenRiskResult: throwError(() => new Error('risk engine down')),
    });
    component.customer.set(customer);
    component.facts.set(facts);
    component.assessment.set(assessmentFor('BLOCK', 'high'));
    component.addressControl.setValue(SAMPLE_ADDRESS);

    component.screen();

    // The error callback clears every screening signal — no stale verdict, no spinner stuck on.
    expect(component.screening()).toBe(false);
    expect(component.factsError()).toBe(false);
    expect(component.assessment()).toBeNull();
    expect(component.simSignals()).toEqual([]);
    expect(component.lastTxHash()).toBeNull();
  });

  it('keeps lastTxHash null when the backend marks the screening as NOT simulated', () => {
    const { component, web3 } = setup({
      screenRiskResult: of({
        address: SAMPLE_ADDRESS,
        decision: 'ALLOW',
        isSimulated: false,
        providerName: 'real-provider',
        signals: clearSignals,
      }),
    });
    component.customer.set(customer);
    component.addressControl.setValue(SAMPLE_ADDRESS);

    component.screen();

    // isSimulated:false → the ternary's null arm; no fabricated sim hash is shown.
    expect(component.lastTxHash()).toBeNull();
    expect(web3.simulatedLastTxHash).not.toHaveBeenCalled();
  });

  it('clears the credential preview when the backend preview load fails (no stale VC)', () => {
    const { component } = setup({
      credentialResult: throwError(() => new Error('vc unavailable')),
    });
    component.ngOnInit();
    // The catchError arm sets vc back to null and stops the loading flag.
    expect(component.vc()).toBeNull();
    expect(component.loadingVc()).toBe(false);
  });

  it('primes the same customer more than once without auto-screening the derived demo address', () => {
    const { component, web3 } = setup();
    component.ngOnInit();
    const screenCalls = web3.screenRisk.mock.calls.length;
    expect(screenCalls).toBe(0);

    // Re-priming the SAME customer only keeps the derived placeholder ready for an explicit operator action.
    (
      component as unknown as { primeScreeningAddress: (c: Customer) => void }
    ).primeScreeningAddress(customer);
    expect(web3.screenRisk).toHaveBeenCalledTimes(screenCalls);
  });

  it('derives the screening address from the customer id when no wallet number exists', () => {
    const { component, web3 } = setup({
      customerResult: of({ ...customer, walletNumber: '' }),
    });
    component.ngOnInit();
    // walletNumber is empty → the `walletNumber || id` fallback derives from the customer id instead.
    expect(web3.deriveScreeningAddress).toHaveBeenCalledWith(customer.id);
  });

  it('(W3-02) keeps the simulated last-tx as a derived hash (template renders it plain, no explorer link)', () => {
    // The template binds lastTxHash() as plain mono text + a not-a-real-tx note, and no longer
    // wires txExplorerUrl() to it. Here we pin the state the @if (lastTxHash()) block renders.
    const { component, web3 } = setup({
      screenRiskResult: of({
        address: SAMPLE_ADDRESS,
        decision: 'ALLOW',
        isSimulated: true,
        providerName: 'rule-based-risk-engine',
        signals: clearSignals,
      }),
    });
    component.customer.set(customer);
    component.addressControl.setValue(SAMPLE_ADDRESS);

    component.screen();

    expect(component.lastTxHash()).toBe(`0xsimulated-${SAMPLE_ADDRESS.slice(2, 10)}`);
    expect(web3.simulatedLastTxHash).toHaveBeenCalledWith(SAMPLE_ADDRESS);
    // txExplorerUrl stays a generic service-link helper, but is no longer invoked for the sim hash.
    expect(web3.explorerTxUrl).not.toHaveBeenCalled();
  });
});
