/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  TransactionsState,
  transactionsFeatureKey,
} from '@features/customers/state/transactions/transactions.reducer';

export const selectTransactionsState =
  createFeatureSelector<TransactionsState>(transactionsFeatureKey);

export const selectTransactionsData = createSelector(selectTransactionsState, state => state.data);

export const selectTransactionsTotal = createSelector(
  selectTransactionsState,
  state => state.total,
);

export const selectTransactionsLoading = createSelector(
  selectTransactionsState,
  state => state.loading,
);

export const selectTransactionsError = createSelector(
  selectTransactionsState,
  state => state.error,
);
