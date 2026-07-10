/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { LocaleFormatService } from '@core/services/locale-format.service';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { FormControl } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY, forkJoin, of } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  switchMap,
  tap,
} from 'rxjs/operators';

import { AuthService } from '@core/auth/auth.service';
import { CustomersApi } from '@core/api/customers.api';
import { ToastService } from '@core/services/toast.service';
import {
  ChainMeta,
  NetworkInfo,
  OnChainFacts,
  OperatorWallet,
  RiskAssessment,
  RiskDecision,
  RiskSignal,
  Web3Service,
} from '@core/services/web3.service';
import { Customer } from '@shared/models/customer.model';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { UiAlertComponent, UiAlertType } from '@shared/components/ui-alert/ui-alert.component';
import {
  UiProgressComponent,
  UiProgressColor,
} from '@shared/components/ui-progress/ui-progress.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { CustomerStatusBadgeComponent } from '@features/customers/components/customer-status-badge/customer-status-badge.component';
import { VcPreview } from './web3-risk.model';

/** Subset of UiBadgeColor we use here (assignable to the badge input). */
type BadgeColor = 'green' | 'yellow' | 'red' | 'gray' | 'blue';

@Component({
  selector: 'app-web3-risk',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslateModule,
    UiButtonComponent,
    UiBadgeComponent,
    UiAlertComponent,
    UiProgressComponent,
    UiInputComponent,
    UiSkeletonComponent,
    DecimalPipe,
    CustomerStatusBadgeComponent,
  ],
  templateUrl: './web3-risk.component.html',
  styleUrl: './web3-risk.component.scss',
})
export class Web3RiskComponent implements OnInit, OnDestroy {
  /** Reactive locale tag for template pipes — live on language switch (B2). */
  protected readonly locale = inject(LocaleFormatService).localeTag;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly customersApi = inject(CustomersApi);
  private readonly web3 = inject(Web3Service);
  private readonly i18n = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** Defense-in-depth RBAC gate; reads the principal via a computed so OnPush re-evaluates. */
  protected readonly auth = inject(AuthService);

  private walletCleanup: (() => void) | null = null;

  readonly chain: ChainMeta = this.web3.chainMeta();
  readonly addressControl = new FormControl<string>('', { nonNullable: true });

  // (1) Customer context
  readonly customer = signal<Customer | null>(null);
  readonly loadingCustomer = signal(true);

  // (2) Operator wallet
  readonly hasWallet = signal(this.web3.hasWallet());
  readonly operator = signal<OperatorWallet | null>(null);
  readonly walletError = signal<string | null>(null);
  readonly signature = signal<string | null>(null);

  // (3) REAL on-chain facts
  readonly screening = signal(false);
  readonly facts = signal<OnChainFacts | null>(null);
  readonly factsError = signal(false);
  readonly addressInvalid = signal(false);
  readonly network = signal<NetworkInfo | null>(null);
  readonly screenedAddress = signal<string>('');

  // (4) Rule-based risk intelligence
  readonly simSignals = signal<RiskSignal[]>([]);
  readonly assessment = signal<RiskAssessment | null>(null);
  readonly lastTxHash = signal<string | null>(null);

  // (6) Decision
  readonly recommendation = signal<RiskDecision | null>(null);
  /** Guards against double-submit while the persistence POST is in flight. */
  readonly recording = signal(false);

  /** Visual-only gauge fill for the rule-based risk level (no real score exists). */
  readonly levelPercent = computed(() => {
    const level = this.assessment()?.level;
    if (level === 'high') return 100;
    if (level === 'medium') return 66;
    if (level === 'low') return 34;
    return 0;
  });

  /** True when at least one rule-based signal fired (gates the "flagged" alert banner). */
  readonly hasFlags = computed(() => (this.assessment()?.signals ?? []).some(s => s.hit));

  /** Matching progress-bar fill family for the rule-based risk level. */
  readonly riskProgressColor = computed<UiProgressColor>(() => {
    switch (this.assessment()?.level) {
      case 'high':
        return 'danger';
      case 'medium':
        return 'warning';
      default:
        return 'success';
    }
  });

  /** RemixIcon paired with the risk-level badge so meaning is never color-only. */
  readonly riskLevelIcon = computed(() => {
    switch (this.assessment()?.level) {
      case 'high':
        return 'ri-alarm-warning-line';
      case 'medium':
        return 'ri-error-warning-line';
      default:
        return 'ri-shield-check-line';
    }
  });

  /** Deterministic, templated, i18n explanation — labeled "(heuristic)". */
  readonly explanation = computed(() => {
    const assessment = this.assessment();
    if (!assessment) return '';
    const flagged = assessment.signals.filter(s => s.hit);
    const list = this.signalExplanationList(flagged);
    return this.i18n.instant('web3.explanation.template', {
      count: flagged.length,
      list,
      decision: this.i18n.instant(`web3.decision.${assessment.decision}`),
    });
  });

  /** (5) DID/VC concept preview — data-minimised, loaded from the backend (NO PII). */
  readonly vc = signal<VcPreview | null>(null);
  readonly loadingVc = signal(false);

  readonly vcJson = computed(() => {
    const vc = this.vc();
    if (!vc) return '';
    return JSON.stringify(vc, null, 2);
  });

  /**
   * (W3-01) True while the screened address is still the auto-derived placeholder
   * (`deriveScreeningAddress`) for the current customer — i.e. no real declared 0x
   * address has been screened yet. Drives the "derived demo address" chip on the
   * REAL-facts panel; the RPC read itself stays genuinely live, only the subject
   * is qualified. Becomes false the moment an operator screens any other address.
   */
  readonly screeningIsDerived = computed(() => {
    const address = this.screenedAddress();
    const customer = this.customer();
    if (!address || !customer) return false;
    const derived = this.web3.deriveScreeningAddress(customer.walletNumber || customer.id);
    return address.toLowerCase() === derived.toLowerCase();
  });

  readonly canRecord = computed(
    () => !!this.customer() && !!this.assessment() && !!this.screenedAddress() && !this.recording(),
  );

  readonly canSignAudit = computed(() => !!this.operator() && !!this.screenedAddress());

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        map(params => params.get('id')),
        filter((id): id is string => !!id),
        distinctUntilChanged(),
        tap(() => this.loadingCustomer.set(true)),
        switchMap(id =>
          this.customersApi.getById(id).pipe(
            catchError(() => {
              this.loadingCustomer.set(false);
              this.toast.error(this.i18n.instant('errors.notFound'));
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(c => {
        this.customer.set(c);
        this.vc.set(null);
        this.loadCredentialPreview(c.id);
        this.primeScreeningAddress(c);
        this.loadingCustomer.set(false);
      });

    this.loadNetwork();
  }

  ngOnDestroy(): void {
    this.walletCleanup?.();
  }

  /** Runs real on-chain reads plus rule-based intelligence for the input address. */
  screen(): void {
    const address = this.addressControl.value.trim();
    const customer = this.customer();
    if (!this.web3.isValidAddress(address)) {
      this.addressInvalid.set(true);
      this.facts.set(null);
      this.assessment.set(null);
      this.simSignals.set([]);
      this.lastTxHash.set(null);
      return;
    }
    if (!customer) return;
    this.addressInvalid.set(false);
    this.screenedAddress.set(address);
    this.screening.set(true);
    this.factsError.set(false);
    this.facts.set(null);
    this.assessment.set(null);
    this.simSignals.set([]);
    this.lastTxHash.set(null);
    this.recommendation.set(null);

    forkJoin({
      facts: this.web3.getOnChainFacts(address).pipe(
        map(facts => ({ facts, failed: false })),
        catchError(() => of({ facts: null, failed: true })),
      ),
      risk: this.web3.screenRisk(customer.id, address),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ facts, risk }) => {
          this.facts.set(facts.facts);
          this.factsError.set(facts.failed);
          this.simSignals.set(risk.signals);
          this.lastTxHash.set(risk.isSimulated ? this.web3.simulatedLastTxHash(address) : null);
          this.assessment.set(this.toAssessment(risk.decision, risk.signals));
          this.screening.set(false);
        },
        error: () => {
          this.screening.set(false);
          this.factsError.set(false);
          this.assessment.set(null);
          this.simSignals.set([]);
          this.lastTxHash.set(null);
        },
      });
  }

  loadNetwork(): void {
    this.web3
      .getNetworkInfo()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: info => this.network.set(info),
        error: () => this.network.set(null),
      });
  }

  private loadCredentialPreview(customerId: string): void {
    this.loadingVc.set(true);
    this.customersApi
      .getCredentialPreview(customerId)
      .pipe(
        catchError(() => {
          this.vc.set(null);
          return EMPTY;
        }),
        finalize(() => this.loadingVc.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(vc => this.vc.set(vc));
  }

  private primeScreeningAddress(customer: Customer): void {
    const address = this.web3.deriveScreeningAddress(customer.walletNumber || customer.id);
    this.addressControl.setValue(address, { emitEvent: false });
  }

  async connect(): Promise<void> {
    this.walletError.set(null);
    try {
      const operator = await this.web3.connectWallet();
      this.operator.set(operator);
      this.walletCleanup?.();
      this.walletCleanup = this.web3.onWalletEvents({
        onAccountsChanged: accounts => {
          if (!accounts.length) {
            this.operator.set(null);
            this.signature.set(null);
            return;
          }
          this.operator.update(o => this.operatorWithAddress(o, accounts[0]));
        },
        onChainChanged: chainIdHex =>
          this.operator.update(o => this.operatorWithChain(o, chainIdHex)),
      });
    } catch (err) {
      this.walletError.set(this.walletErrorMessage(err));
    }
  }

  disconnect(): void {
    this.walletCleanup?.();
    this.walletCleanup = null;
    this.operator.set(null);
    this.signature.set(null);
  }

  /** OPTIONAL proof-of-control attestation (off by default). */
  async signAudit(): Promise<void> {
    const op = this.operator();
    if (!op || !this.screenedAddress()) return;
    this.walletError.set(null);
    try {
      const message = this.i18n.instant('web3.signMessage', { address: this.screenedAddress() });
      this.signature.set(await this.web3.personalSign(op.address, message));
    } catch (err) {
      this.walletError.set(this.walletErrorMessage(err));
    }
  }

  /**
   * Persists the operator's screening decision to the audit-logged backend.
   * The action is RBAC-gated in the template on `kyc.manage`; we also need a
   * screened customer + address.
   *
   * `isSimulated:true` keeps the backend honesty guard satisfied while the rule-based engine is
   * active. On success we reflect the persisted decision locally + toast;
   * on failure we do NOT claim "saved" (leave the verdict unset) and let the
   * global error interceptor surface the translated message (FE-INT-007 path).
   */
  record(decision: RiskDecision): void {
    const customer = this.customer();
    if (!customer || !this.assessment() || !this.screenedAddress() || this.recording()) return;

    this.recording.set(true);
    this.web3
      .recordDecision(customer.id, {
        address: this.screenedAddress(),
        decision,
        isSimulated: true,
        signals: this.simSignals(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.recording.set(false);
          this.recommendation.set(decision);
          this.toast.success(
            this.i18n.instant('web3.record.toast', {
              decision: this.i18n.instant(`web3.decision.${decision}`),
            }),
          );
        },
        error: () => {
          // The error interceptor already surfaces a translated message
          // (403→forbidden, 400→validation, network→…). Do not double-toast and
          // do not set `recommendation` — the decision was NOT persisted.
          this.recording.set(false);
        },
      });
  }

  back(): void {
    const c = this.customer();
    this.router.navigate(this.backRoute(c));
  }

  addressExplorerUrl(): string {
    return this.web3.explorerAddressUrl(this.screenedAddress());
  }

  txExplorerUrl(hash: string): string {
    return this.web3.explorerTxUrl(hash);
  }

  decisionColor(decision: RiskDecision | null | undefined): BadgeColor {
    switch (decision) {
      case 'BLOCK':
        return 'red';
      case 'REVIEW':
        return 'yellow';
      case 'ALLOW':
        return 'green';
      default:
        return 'gray';
    }
  }

  signalColor(hit: boolean): BadgeColor {
    if (hit) return 'red';
    return 'green';
  }

  private toAssessment(decision: RiskDecision, signals: RiskSignal[]): RiskAssessment {
    const level: 'low' | 'medium' | 'high' =
      decision === 'BLOCK' ? 'high' : decision === 'REVIEW' ? 'medium' : 'low';
    return { decision, level, signals };
  }

  /** Alert severity for a single rule-based signal row (danger when it fired, success when clear). */
  signalAlertType(hit: boolean): UiAlertType {
    return hit ? 'danger' : 'success';
  }

  private signalExplanationList(flagged: RiskSignal[]): string {
    if (!flagged.length) return this.i18n.instant('web3.explanation.none');
    return flagged.map(s => this.i18n.instant(`web3.signals.${s.key}`)).join(', ');
  }

  private operatorWithAddress(
    operator: OperatorWallet | null,
    address: string,
  ): OperatorWallet | null {
    if (!operator) return operator;
    return { ...operator, address };
  }

  private operatorWithChain(
    operator: OperatorWallet | null,
    chainIdHex: string,
  ): OperatorWallet | null {
    if (!operator) return operator;
    return { ...operator, chainIdHex };
  }

  private backRoute(customer: Customer | null): string[] {
    if (!customer) return ['/customers'];
    return ['/customers', customer.id];
  }

  private walletErrorMessage(err: unknown): string {
    const code = (err as { code?: number }).code;
    if (code === 4001) return this.i18n.instant('web3.wallet.rejected');
    if ((err as { message?: string }).message === 'no-wallet') {
      return this.i18n.instant('web3.wallet.notFound');
    }
    return this.i18n.instant('web3.wallet.error');
  }
}
