/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormGroup, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY, Observable, Subject } from 'rxjs';
import { catchError, exhaustMap, finalize, ignoreElements, tap } from 'rxjs/operators';

import { WalletsApi } from '@core/api/wallets.api';
import { AppErrorService } from '@core/services/app-error.service';
import { ToastService } from '@core/services/toast.service';
import { LocaleFormatService } from '@core/services/locale-format.service';

import { Wallet, WalletStatus } from '@shared/models/wallet.model';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiFormComponent } from '@shared/components/ui-form/ui-form.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { FieldConfig } from '@shared/components/ui-form/ui-form.types';
import { walletLimitsConsistencyValidator } from '@shared/validators/custom.validators';

/**
 * Wallet daily/monthly limit panel: usage meter + the limit edit form (audit Y-4).
 * Extracted from the customer-detail god-component. Owns its own form lifecycle, which removed the
 * former dead-pager ViewChild-setter timing hack — the form here exists for the component's whole
 * life, so the save stream wires once at construction.
 *
 * The panel writes the limits itself (WalletsApi.updateLimits) and emits the fresh wallet so the
 * parent can refresh dependent display (the balance/metrics rail). Behaviour is byte-identical to the
 * pre-split flow: same validators, same limitMismatch handling, same rowVersion + toast + form reset.
 */
@Component({
  selector: 'app-customer-wallet-limits',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiBadgeComponent,
    UiButtonComponent,
    UiFormComponent,
    UiSkeletonComponent,
  ],
  templateUrl: './customer-wallet-limits.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'enterprise-panel', id: 'customer-detail-wallet-limits-card' },
})
export class CustomerWalletLimitsComponent {
  /** The wallet whose limits this panel displays/edits; null until the parent resolves it. */
  @Input() set wallet(value: Wallet | null) {
    this._wallet.set(value);
    if (value) {
      this.limitsInitialValue.set({
        dailyLimit: value.dailyLimit,
        monthlyLimit: value.monthlyLimit,
      });
    }
  }
  get wallet(): Wallet | null {
    return this._wallet();
  }

  /** The customer id, used as the path segment for the limit-update request. */
  @Input({ required: true }) customerId!: string;
  /**
   * RBAC gate (`wallets.manage-limits`). A7 (bugfix-backlog-2026-07): without it the editor is
   * READ-ONLY — the inputs lose their edit affordance and Save/Reset never render (the old
   * grey-disabled Save advertised an action the operator could never take). The BE PATCH stays
   * the real authority (403, proven in customer-writes.int-spec).
   */
  @Input() set canManageLimits(value: boolean) {
    this._canManageLimits = value;
    this.limitFields = this.buildLimitFields(value);
  }
  get canManageLimits(): boolean {
    return this._canManageLimits;
  }
  private _canManageLimits = false;

  /** Emits the updated wallet after a successful save so the parent can refresh its display. */
  @Output() walletUpdated = new EventEmitter<Wallet>();

  @ViewChild('limitsFormRef') limitsForm?: UiFormComponent;

  private readonly _wallet = signal<Wallet | null>(null);
  private readonly saveLimits$ = new Subject<void>();
  private readonly destroyRef = inject(DestroyRef);
  private readonly walletsApi = inject(WalletsApi);
  private readonly toast = inject(ToastService);
  private readonly appError = inject(AppErrorService);
  private readonly i18n = inject(TranslateService);
  private readonly fmt = inject(LocaleFormatService);

  readonly savingLimits = signal(false);
  readonly limitsInitialValue = signal<Record<string, unknown> | null>(null);

  limitFields: FieldConfig[] = this.buildLimitFields(false);

  /** Same two fields; `readOnly` mirrors the RBAC gate so a viewer sees values, not an editor (A7). */
  private buildLimitFields(canManage: boolean): FieldConfig[] {
    return [
      {
        name: 'dailyLimit',
        labelKey: 'wallet.dailyLimit',
        type: 'number',
        readOnly: !canManage,
        validators: [Validators.required, Validators.min(1)],
      },
      {
        name: 'monthlyLimit',
        labelKey: 'wallet.monthlyLimit',
        type: 'number',
        readOnly: !canManage,
        validators: [Validators.required, Validators.min(1)],
      },
    ];
  }
  limitFormValidators = [walletLimitsConsistencyValidator('dailyLimit', 'monthlyLimit')];

  constructor() {
    this.saveLimits$
      .pipe(
        exhaustMap(() => {
          // A7 defense-in-depth: the actions are permission-hidden, but the stream guards too.
          if (!this.canManageLimits) return EMPTY;
          const form = this.limitsForm?.form;
          if (!form) return EMPTY;
          form.updateValueAndValidity({ emitEvent: false });
          form.markAllAsTouched();
          if (form.invalid) return EMPTY;

          const value = form.getRawValue() as {
            dailyLimit?: number | null;
            monthlyLimit?: number | null;
          };
          const dailyLimit = Number(value.dailyLimit);
          const monthlyLimit = Number(value.monthlyLimit);
          if (
            Number.isFinite(dailyLimit) &&
            Number.isFinite(monthlyLimit) &&
            dailyLimit >= monthlyLimit
          ) {
            form.setErrors({ ...(form.errors ?? {}), limitMismatch: true });
            return EMPTY;
          } else if (form.errors?.['limitMismatch']) {
            const { limitMismatch, ...rest } = form.errors as Record<string, unknown>;
            this.setRemainingErrors(form, rest);
          }

          const payload = { dailyLimit, monthlyLimit, rowVersion: this._wallet()?.rowVersion ?? 0 };
          this.savingLimits.set(true);
          return this.walletsApi.updateLimits(this.customerId, payload).pipe(
            tap(w => {
              this._wallet.set(w);
              const updatedLimits = {
                dailyLimit: w.dailyLimit,
                monthlyLimit: w.monthlyLimit,
              };
              this.limitsInitialValue.set(updatedLimits);
              this.toast.success(this.i18n.instant('wallet.updated'));
              form.reset(updatedLimits, { emitEvent: false });
              form.markAsPristine();
              form.markAsUntouched();
              form.updateValueAndValidity({ emitEvent: false });
              this.walletUpdated.emit(w);
            }),
            catchError(err => {
              // Existing surface first: the 409 maps to the `errors.code.Wallets.Conflict` toast.
              this.appError.handleError(err, {
                source: 'CustomerWalletLimitsComponent',
                operation: 'updateLimits',
              });
              // Optimistic-concurrency conflict (Wallets.Conflict): the stored rowVersion moved on,
              // so retrying the SAME payload would 409 forever. Re-fetch the wallet so the form
              // re-seeds with the fresh values + rowVersion and the next save can succeed.
              if (this.isConflict(err)) {
                return this.recoverFromConflict(form);
              }
              return EMPTY;
            }),
            finalize(() => {
              this.savingLimits.set(false);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  /** Wallet lifecycle label, translated for the panel badge. */
  walletStatusDisplay(): string {
    return this.i18n.instant(`wallet.status.${this.walletStatus()}`);
  }

  /** Status badge tone for the wallet lifecycle. */
  walletStatusColor(): 'green' | 'yellow' | 'gray' {
    const status = this.walletStatus();
    if (status === 'FROZEN') return 'yellow';
    if (status === 'CLOSED') return 'gray';
    return 'green';
  }

  /** Ratio of daily limit to monthly limit, clamped for the visual meter. */
  limitRatioPercent(): number {
    const w = this._wallet();
    if (!w?.monthlyLimit) return 0;
    const ratio = (Number(w.dailyLimit) / Number(w.monthlyLimit)) * 100;
    if (!Number.isFinite(ratio)) return 0;
    return Math.max(0, Math.min(100, Math.round(ratio)));
  }

  limitRatioBarClass(): string {
    const ratio = this.limitRatioPercent();
    if (ratio >= 80) return 'meter-bar--danger';
    if (ratio >= 55) return 'meter-bar--warning';
    if (ratio >= 30) return 'meter-bar--info';
    return 'meter-bar--success';
  }

  /** Localized percent label for the limit usage meter. */
  limitRatioDisplay(): string {
    // B2: central locale service (live on language switch).
    return this.fmt.percent(this.limitRatioPercent());
  }

  saveLimits(): void {
    this.saveLimits$.next();
  }

  /** True for the backend's optimistic-concurrency conflict on the wallet PATCH (409). */
  private isConflict(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 409;
  }

  /**
   * Conflict recovery (409 `Wallets.Conflict`): another operator changed the wallet, so the panel's
   * rowVersion is stale. Re-fetch through the panel's existing wallet source (WalletsApi — the same
   * client it saves through), re-seed the form with the FRESH values + rowVersion, and emit
   * `walletUpdated` so the parent rail/meter reflect the other operator's change too. A failed
   * re-fetch is surfaced through the standard error path and leaves the stale form untouched.
   */
  private recoverFromConflict(form: FormGroup): Observable<never> {
    return this.walletsApi.getByCustomerId(this.customerId).pipe(
      tap(w => {
        this._wallet.set(w);
        const freshLimits = { dailyLimit: w.dailyLimit, monthlyLimit: w.monthlyLimit };
        this.limitsInitialValue.set(freshLimits);
        form.reset(freshLimits, { emitEvent: false });
        form.markAsPristine();
        form.markAsUntouched();
        form.updateValueAndValidity({ emitEvent: false });
        this.walletUpdated.emit(w);
      }),
      catchError(reloadErr => {
        this.appError.handleError(reloadErr, {
          source: 'CustomerWalletLimitsComponent',
          operation: 'reloadWalletAfterConflict',
        });
        return EMPTY;
      }),
      ignoreElements(),
    );
  }

  resetLimits(): void {
    const form = this.limitsForm?.form;
    if (!form) return;
    const value = this.currentLimitsInitialValue();
    form.reset(value, { emitEvent: false });
    form.markAsPristine();
    form.markAsUntouched();
    form.updateValueAndValidity({ emitEvent: false });
  }

  private currentLimitsInitialValue(): Record<string, unknown> {
    return this.limitsInitialValue() ?? { dailyLimit: null, monthlyLimit: null };
  }

  private walletStatus(): WalletStatus {
    return this._wallet()?.status ?? 'ACTIVE';
  }

  private setRemainingErrors(
    control: { setErrors: (errors: Record<string, unknown> | null) => void } | null,
    errors: Record<string, unknown>,
  ): void {
    if (Object.keys(errors).length) {
      control?.setErrors(errors);
      return;
    }
    control?.setErrors(null);
  }
}
