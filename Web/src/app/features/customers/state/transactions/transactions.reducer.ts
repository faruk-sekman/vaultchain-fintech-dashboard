/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createReducer, on } from '@ngrx/store';
import { Transaction } from '@shared/models/transaction.model';
import {
  loadTransactions,
  loadTransactionsFailure,
  loadTransactionsSuccess,
} from '@features/customers/state/transactions/transactions.actions';

export const transactionsFeatureKey = 'transactions';

export interface TransactionsState {
  data: Transaction[];
  total: number;
  loading: boolean;
  error: unknown | null;
}

export const initialState: TransactionsState = {
  data: [],
  total: 0,
  loading: false,
  error: null,
};

export const transactionsReducer = createReducer(
  initialState,
  on(loadTransactions, state => ({ ...state, loading: true, error: null })),
  on(loadTransactionsSuccess, (state, { data, total }) => ({
    ...state,
    data,
    total,
    loading: false,
    error: null,
  })),
  on(loadTransactionsFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
);
