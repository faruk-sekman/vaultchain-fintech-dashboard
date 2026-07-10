/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createReducer, on } from '@ngrx/store';
import { Customer } from '@shared/models/customer.model';
import { ListCustomersParams } from '@core/api/customers.api';
import {
  deleteCustomer,
  deleteCustomerFailure,
  deleteCustomerSuccess,
  loadCustomers,
  loadCustomersFailure,
  loadCustomersSuccess,
} from '@features/customers/state/customers/customers.actions';

export const customersFeatureKey = 'customers';

export interface CustomersState {
  data: Customer[];
  total: number;
  loading: boolean;
  error: unknown | null;
  /** Params of the LAST list load — lets success-effects reload the exact current view (A4). */
  lastParams: ListCustomersParams | null;
  deleting: boolean;
  deletingId: string | null;
  deleteError: unknown | null;
}

export const initialState: CustomersState = {
  data: [],
  total: 0,
  loading: false,
  error: null,
  lastParams: null,
  deleting: false,
  deletingId: null,
  deleteError: null,
};

export const customersReducer = createReducer(
  initialState,
  on(loadCustomers, (state, { params }) => ({
    ...state,
    loading: true,
    error: null,
    lastParams: params,
  })),
  on(loadCustomersSuccess, (state, { data, total }) => ({
    ...state,
    data,
    total,
    loading: false,
    error: null,
  })),
  on(loadCustomersFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(deleteCustomer, (state, { id }) => ({
    ...state,
    deleting: true,
    deletingId: id,
    deleteError: null,
  })),
  on(deleteCustomerSuccess, (state, { id }) => {
    const nextData = state.data.filter(item => item.id !== id);
    const removed = nextData.length !== state.data.length;
    let total = state.total;
    if (removed) {
      total = Math.max(0, state.total - 1);
    }
    return {
      ...state,
      data: nextData,
      total,
      deleting: false,
      deletingId: null,
      deleteError: null,
    };
  }),
  on(deleteCustomerFailure, (state, { error }) => ({
    ...state,
    deleting: false,
    deletingId: null,
    deleteError: error,
  })),
);
