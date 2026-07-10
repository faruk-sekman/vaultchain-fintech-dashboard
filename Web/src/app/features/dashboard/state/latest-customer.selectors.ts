/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  LatestCustomerState,
  latestCustomerFeatureKey,
} from '@features/dashboard/state/latest-customer.reducer';

export const selectLatestCustomerState =
  createFeatureSelector<LatestCustomerState>(latestCustomerFeatureKey);

export const selectLatestCustomer = createSelector(
  selectLatestCustomerState,
  state => state.latest,
);

export const selectLatestCustomerLoading = createSelector(
  selectLatestCustomerState,
  state => state.loading,
);

export const selectLatestCustomerLoaded = createSelector(
  selectLatestCustomerState,
  state => state.loaded,
);

export const selectLatestCustomerError = createSelector(
  selectLatestCustomerState,
  state => state.error,
);

export const selectRecentCustomers = createSelector(
  selectLatestCustomerState,
  state => state.recent,
);

export const selectRecentCustomersLoading = createSelector(
  selectLatestCustomerState,
  state => state.recentLoading,
);

export const selectRecentCustomersLoaded = createSelector(
  selectLatestCustomerState,
  state => state.recentLoaded,
);

export const selectRecentCustomersError = createSelector(
  selectLatestCustomerState,
  state => state.recentError,
);
