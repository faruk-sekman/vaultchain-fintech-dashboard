/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY, Subject, combineLatest } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  finalize,
  map,
  shareReplay,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';

import { AuthService } from '@core/auth/auth.service';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { CustomersApi } from '@core/api/customers.api';
import { WalletsApi } from '@core/api/wallets.api';
import { ToastService } from '@core/services/toast.service';
import { AppErrorService } from '@core/services/app-error.service';

import { Customer } from '@shared/models/customer.model';
import { Wallet } from '@shared/models/wallet.model';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiBreadcrumbItem } from '@shared/components/ui-breadcrumb/ui-breadcrumb.component';
import { UiAvatarComponent } from '@shared/components/ui-avatar/ui-avatar.component';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { HasPermissionDirective } from '@shared/directives/has-permission.directive';
import { CustomerStatusBadgeComponent } from '@features/customers/components/customer-status-badge/customer-status-badge.component';
import { CustomersStore } from '@features/customers/state';
import { CustomerWalletLimitsComponent } from './components/customer-wallet-limits/customer-wallet-limits.component';
import { CustomerTransactionsComponent } from './components/customer-transactions/customer-transactions.component';
import { CustomerKycHistoryComponent } from './components/customer-kyc-history/customer-kyc-history.component';
import { CustomerRiskHistoryComponent } from './components/customer-risk-history/customer-risk-history.component';

/**
 * Thin customer-detail container (audit Y-4). After the god-component split it owns only
 * the customer identity header + metrics rail, the admin PII reveal orchestration, the delete flow,
 * routing, the wallet load, and composing the four focused child panels (wallet-limits, transactions,
 * KYC history, risk history). Each child owns its own data lifecycle and form, which also retired the
 * former dead-pager ViewChild timing hack.
 */
@Component({
  selector: 'app-customer-detail',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiButtonComponent,
    UiSkeletonComponent,
    CustomerStatusBadgeComponent,
    UiConfirmDialogComponent,
    UiAvatarComponent,
    UiBadgeComponent,
    HasPermissionDirective,
    CustomerWalletLimitsComponent,
    CustomerTransactionsComponent,
    CustomerKycHistoryComponent,
    CustomerRiskHistoryComponent,
  ],
  templateUrl: './customer-detail.component.html',
  styleUrl: './customer-detail.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerDetailComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();
  /** Admin-only PII reveal toggle; carries the REQUESTED reveal state. */
  private readonly revealToggle$ = new Subject<boolean>();
  private readonly customersStore = inject(CustomersStore);
  /** Defense-in-depth RBAC gate; reads the principal via a computed so OnPush re-evaluates. */
  protected readonly auth = inject(AuthService);
  id!: string;

  readonly customer = signal<Customer | null>(null);
  readonly wallet = signal<Wallet | null>(null);

  /**
   * PII reveal view-state — holds ONLY the boolean, never PII. Default masked;
   * reset to `false` on every `id` change (no persistence). The control that flips it renders only for a
   * principal holding `customers.pii.reveal`; the server remains the authority on whether data is unmasked.
   */
  readonly reveal = signal(false);

  readonly loadingCustomer = signal(true);
  readonly loadingWallet = signal(true);

  readonly deleteModalOpen = signal(false);
  readonly deletingCustomer = signal(false);

  readonly breadcrumbItems: UiBreadcrumbItem[] = [
    { labelKey: 'customers.title', link: '/customers' },
    { labelKey: 'customerDetail.title' },
  ];

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly customersApi: CustomersApi,
    private readonly walletsApi: WalletsApi,
    private readonly toast: ToastService,
    private readonly appError: AppErrorService,
    private readonly i18n: TranslateService,
    private readonly fmt: LocaleFormatService,
  ) {}

  ngOnInit(): void {
    const id$ = this.route.paramMap.pipe(
      map(params => params.get('id')),
      filter((id): id is string => !!id),
      distinctUntilChanged(),
      tap(id => {
        this.id = id;
        this.customer.set(null);
        this.wallet.set(null);
        this.reveal.set(false); // default masked on every navigation (no reveal persistence)
        this.loadingCustomer.set(true);
        this.loadingWallet.set(false);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    const customer$ = id$.pipe(
      switchMap(id =>
        this.customersApi.getById(id).pipe(
          tap(c => {
            this.customer.set(c);
          }),
          catchError(err => {
            this.appError.handleError(err, {
              source: 'CustomerDetailComponent',
              operation: 'loadCustomer',
            });
            return EMPTY;
          }),
          finalize(() => {
            this.loadingCustomer.set(false);
          }),
        ),
      ),
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    customer$.pipe(takeUntil(this.destroy$)).subscribe();

    // Admin-only PII reveal: a toggle re-fetches THIS customer with/without reveal=true.
    // switchMap ⇒ last-write-wins, so a slow earlier response can never paint unmasked data under a later
    // masked toggle (or vice-versa). The server is the authority — a fail-closed masked response just renders
    // masked (no error). This path deliberately does NOT reload the wallet/tx/kyc/risk panels.
    this.revealToggle$
      .pipe(
        tap(next => this.reveal.set(next)),
        switchMap(next =>
          this.customersApi.getById(this.id, { reveal: next }).pipe(
            tap(c => this.customer.set(c)),
            catchError(err => {
              this.appError.handleError(err, {
                source: 'CustomerDetailComponent',
                operation: 'revealCustomer',
              });
              return EMPTY;
            }),
          ),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe();

    customer$
      .pipe(
        tap(() => this.loadingWallet.set(true)),
        switchMap(customer =>
          this.walletsApi.getByCustomerId(customer.id).pipe(
            tap(w => {
              this.wallet.set(w);
            }),
            catchError(err => {
              this.appError.handleError(err, {
                source: 'CustomerDetailComponent',
                operation: 'loadWallet',
              });
              return EMPTY;
            }),
            finalize(() => {
              this.loadingWallet.set(false);
            }),
          ),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe();

    combineLatest([this.customersStore.deleting$, this.customersStore.deletingId$])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([deleting, deletingId]) => {
        this.deletingCustomer.set(deleting && deletingId === this.id);
      });

    this.customersStore.deleteSuccess$
      .pipe(
        filter(({ id }) => id === this.id),
        takeUntil(this.destroy$),
      )
      .subscribe(() => {
        this.closeDelete();
        this.router.navigate(['/customers']);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  back() {
    this.router.navigate(['/customers']);
  }
  edit() {
    this.router.navigate(['/customers', this.id, 'edit']);
  }
  web3Risk() {
    this.router.navigate(['/customers', this.id, 'web3-risk']);
  }

  /**
   * Admin-only: flip PII reveal and re-fetch. NO client-side unmask — the toggle
   * re-fetches with/without `reveal=true` and the wire response is the only source of unmasked PII; toggling
   * OFF re-fetches masked, so no prior unmasked value is retained. Carries only the boolean state.
   */
  toggleReveal() {
    this.revealToggle$.next(!this.reveal());
  }

  /** Balance stat value, locale-formatted with the wallet currency; null → empty tile while no wallet. */
  walletBalanceDisplay(): string | null {
    const w = this.wallet();
    if (!w) return null;
    return this.formatCurrency(w.balance, w.currency);
  }

  /** "Member since" stat value from the customer's createdAt; null → empty tile until loaded. */
  memberSinceDisplay(): string | null {
    const c = this.customer();
    if (!c?.createdAt) return null;
    const date = new Date(c.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return this.fmt.date(date, 'mediumDate');
  }

  /** A successful in-panel transaction create changed the balance — reload the wallet for the rail. */
  reloadWallet(): void {
    if (!this.id) return;
    this.walletsApi
      .getByCustomerId(this.id)
      .pipe(
        catchError(err => {
          this.appError.handleError(err, {
            source: 'CustomerDetailComponent',
            operation: 'reloadWallet',
          });
          return EMPTY;
        }),
        takeUntil(this.destroy$),
      )
      .subscribe(w => this.wallet.set(w));
  }

  /** The wallet-limits child saved new limits; mirror the fresh wallet so the rail/meter stay in sync. */
  onWalletUpdated(wallet: Wallet): void {
    this.wallet.set(wallet);
  }

  private formatCurrency(value: number, currency: string): string {
    try {
      // B2/B3: central locale service — symbol notation, active-language locale, live on switch.
      return this.fmt.currency(value, currency);
    } catch {
      // Unknown/invalid currency code → fall back to a plain number + raw code.
      return `${this.fmt.number(value)} ${currency}`;
    }
  }

  openDelete() {
    this.deleteModalOpen.set(true);
  }

  closeDelete() {
    this.deleteModalOpen.set(false);
  }

  confirmDelete() {
    if (!this.id || this.deletingCustomer()) return;
    this.customersStore.delete(this.id);
  }
}
