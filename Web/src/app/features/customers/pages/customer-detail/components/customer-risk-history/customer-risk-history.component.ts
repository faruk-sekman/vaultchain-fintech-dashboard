/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Input,
  OnChanges,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY, Subject } from 'rxjs';
import { catchError, finalize, switchMap, tap } from 'rxjs/operators';

import { AppErrorService } from '@core/services/app-error.service';
import { RiskAssessmentRecord, RiskDecision, Web3Service } from '@core/services/web3.service';

import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { UiPaginationComponent } from '@shared/components/ui-pagination/ui-pagination.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';

/**
 * Web3 risk-decision history panel + its server-side pager (audit Y-4). Extracted from
 * the customer-detail god-component. Loads its own page via a reload Subject + switchMap (last-write-
 * wins), preserving the prior shape, the `isSimulated` labelling, and the BLOCK/REVIEW/ALLOW tone.
 *
 * Simulated AML signals stay visually separated and labelled (read-only, non-custodial). pageSize 5 ⇒
 * the pager self-hides at ≤1 page. A customer-id change re-seeds page 1 and reloads.
 */
@Component({
  selector: 'app-customer-risk-history',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiBadgeComponent,
    UiPaginationComponent,
    UiSkeletonComponent,
  ],
  templateUrl: './customer-risk-history.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'enterprise-panel', id: 'customer-detail-web3-risk-card' },
})
export class CustomerRiskHistoryComponent implements OnChanges {
  /** Customer whose risk-decision history this panel lists; a change reloads from page 1. */
  @Input({ required: true }) customerId!: string;

  private readonly web3 = inject(Web3Service);
  private readonly appError = inject(AppErrorService);
  private readonly i18n = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  /** Page-number reload trigger for the server-side-paged risk-decision history panel. */
  private readonly riskReload$ = new Subject<number>();

  readonly loadingRiskHistory = signal(false);
  readonly riskHistory = signal<RiskAssessmentRecord[]>([]);
  /** Server-side paging: pageSize 5 ⇒ the pager shows only when >5. */
  readonly riskPage = signal(1);
  readonly riskTotal = signal(0);
  readonly riskPageSize = 5;

  constructor() {
    // Server-side-paged risk decision history; same shape, isSimulated preserved.
    this.riskReload$
      .pipe(
        tap(() => this.loadingRiskHistory.set(true)),
        switchMap(page =>
          this.web3
            .listRiskAssessments(this.customerId, { page, pageSize: this.riskPageSize })
            .pipe(
              catchError(err => {
                this.appError.handleError(err, {
                  source: 'CustomerRiskHistoryComponent',
                  operation: 'loadRiskHistory',
                });
                return EMPTY;
              }),
              finalize(() => this.loadingRiskHistory.set(false)),
            ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(res => {
        this.riskHistory.set(res.data);
        this.riskTotal.set(res.total);
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['customerId'];
    if (change && this.customerId) {
      this.riskPage.set(1);
      this.riskHistory.set([]);
      this.riskTotal.set(0);
      this.riskReload$.next(1);
    }
  }

  onRiskPageChange(e: { page: number; pageSize: number }): void {
    this.riskPage.set(e.page);
    this.riskReload$.next(e.page);
  }

  /**
   * Decision → badge tone, matched to SEMANTICS (design review, cross-cutting rule 4): ALLOW=green,
   * BLOCK=red, REVIEW=blue/info. REVIEW is a neutral "needs a human look" state, NOT a warning, so it
   * must not borrow the warning-yellow hue (that tone is reserved for the simulated-signal flag here).
   */
  riskDecisionColor(decision: RiskDecision): 'green' | 'blue' | 'red' {
    if (decision === 'BLOCK') return 'red';
    if (decision === 'REVIEW') return 'blue';
    return 'green';
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
}
