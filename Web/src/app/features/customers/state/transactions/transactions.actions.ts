/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createAction, props } from '@ngrx/store';
import { Transaction } from '@shared/models/transaction.model';
import { ListTransactionsParams } from '@core/api/transactions.api';

export const loadTransactions = createAction(
  '[Transactions] Load',
  props<{ customerId: string; params: ListTransactionsParams }>(),
);

export const loadTransactionsSuccess = createAction(
  '[Transactions] Load Success',
  props<{ data: Transaction[]; total: number }>(),
);

export const loadTransactionsFailure = createAction(
  '[Transactions] Load Failure',
  props<{ error: unknown }>(),
);
