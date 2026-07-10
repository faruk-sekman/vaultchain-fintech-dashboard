/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

import { UiPaginationComponent } from '@shared/components/ui-pagination/ui-pagination.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { CustomerStatusBadgeComponent } from '@features/customers/components/customer-status-badge/customer-status-badge.component';
import { KycVerificationsStore } from '@features/customers/state';

/**
 * KYC verification history panel + its server-side pager (audit Y-4). Extracted from the
 * customer-detail god-component. Store-backed: reads the shared KYC slice and dispatches
 * the page loads itself, so the container no longer orchestrates this panel's data lifecycle.
 *
 * pageSize 5 ⇒ the pager self-hides at ≤1 page. The customer id arrives as an input; a change re-seeds
 * page 1 and reloads, mirroring the prior container behaviour exactly.
 */
@Component({
  selector: 'app-customer-kyc-history',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiPaginationComponent,
    UiSkeletonComponent,
    CustomerStatusBadgeComponent,
  ],
  templateUrl: './customer-kyc-history.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'enterprise-panel', id: 'customer-detail-kyc-history-card' },
})
export class CustomerKycHistoryComponent implements OnChanges {
  /** Customer whose KYC history this panel lists; a change reloads from page 1. */
  @Input({ required: true }) customerId!: string;

  private readonly kycVerificationsStore = inject(KycVerificationsStore);
  private readonly i18n = inject(TranslateService);

  /** Server-side paging: pageSize 5 ⇒ the pager shows only when >5. */
  readonly kycPage = signal(1);
  readonly kycPageSize = 5;

  readonly kycData$ = this.kycVerificationsStore.data$;
  readonly kycTotal$ = this.kycVerificationsStore.total$;
  readonly loadingKyc$ = this.kycVerificationsStore.loading$;

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['customerId'];
    if (change && this.customerId) {
      this.kycPage.set(1);
      this.dispatchKycLoad(1);
    }
  }

  onKycPageChange(e: { page: number; pageSize: number }): void {
    this.kycPage.set(e.page);
    this.dispatchKycLoad(e.page);
  }

  /**
   * Translate a KYC verification method (a free backend string, e.g. `manual`, `e_kyc`,
   * `manual_review`) via the `customerDetail.kycMethod.*` keys, with a Title-Case fallback so a raw
   * token never leaks untranslated into the UI (audit D8).
   */
  kycMethodLabel(method: string | null | undefined): string {
    if (!method) return '—';
    const key = `customerDetail.kycMethod.${method.toLowerCase()}`;
    const translated = this.i18n.instant(key);
    if (translated && translated !== key) return translated;
    return method
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Short date in the ACTIVE language's locale so the rows reformat live on a no-reload language
   * switch, instead of the bootstrap-fixed `| date` pipe whose LOCALE_ID never updates (audit D9).
   */
  formatShortDate(value: string | Date | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(this.localeTag(), { dateStyle: 'short' }).format(date);
  }

  private localeTag(): string {
    return this.i18n.currentLang === 'tr' ? 'tr-TR' : 'en-US';
  }

  private dispatchKycLoad(page: number): void {
    this.kycVerificationsStore.load(this.customerId, { page, pageSize: this.kycPageSize });
  }
}
