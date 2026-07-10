/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';

import { ListTransactionsParams } from '@core/api/transactions.api';
import { loadTransactions } from '@features/customers/state/transactions/transactions.actions';
import {
  selectTransactionsData,
  selectTransactionsLoading,
  selectTransactionsTotal,
} from '@features/customers/state/transactions/transactions.selectors';

@Injectable({ providedIn: 'root' })
export class TransactionsStore {
  private readonly store = inject(Store);

  readonly data$ = this.store.select(selectTransactionsData);
  readonly total$ = this.store.select(selectTransactionsTotal);
  readonly loading$ = this.store.select(selectTransactionsLoading);

  load(customerId: string, params: ListTransactionsParams) {
    this.store.dispatch(loadTransactions({ customerId, params }));
  }
}
