/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createReducer, on } from '@ngrx/store';
import { LatestCustomer } from '@core/api/dashboard.api';
import { Customer } from '@shared/models/customer.model';
import {
  loadLatestCustomer,
  loadLatestCustomerFailure,
  loadLatestCustomerSuccess,
  loadRecentCustomers,
  loadRecentCustomersFailure,
  loadRecentCustomersSuccess,
} from '@features/dashboard/state/latest-customer.actions';

export const latestCustomerFeatureKey = 'latestCustomer';

export interface LatestCustomerState {
  latest: LatestCustomer | null;
  loading: boolean;
  loaded: boolean;
  error: unknown | null;
  /** v2.1 §5 "Recent Customers": latest-customer read model (masked by the API). */
  recent: Customer[];
  recentLoading: boolean;
  recentLoaded: boolean;
  recentError: unknown | null;
}

export const initialState: LatestCustomerState = {
  latest: null,
  loading: false,
  loaded: false,
  error: null,
  recent: [],
  recentLoading: false,
  recentLoaded: false,
  recentError: null,
};

export const latestCustomerReducer = createReducer(
  initialState,
  on(loadLatestCustomer, state => ({ ...state, loading: true, loaded: false, error: null })),
  on(loadLatestCustomerSuccess, (state, { latest }) => ({
    ...state,
    latest,
    loading: false,
    loaded: true,
    error: null,
  })),
  on(loadLatestCustomerFailure, (state, { error }) => ({
    ...state,
    loading: false,
    loaded: true,
    error,
  })),
  on(loadRecentCustomers, state => ({
    ...state,
    recentLoading: true,
    recentLoaded: false,
    recentError: null,
  })),
  on(loadRecentCustomersSuccess, (state, { customers }) => ({
    ...state,
    recent: customers,
    recentLoading: false,
    recentLoaded: true,
    recentError: null,
  })),
  on(loadRecentCustomersFailure, (state, { error }) => ({
    ...state,
    recentLoading: false,
    recentLoaded: true,
    recentError: error,
  })),
);
