/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  CustomersState,
  customersFeatureKey,
} from '@features/customers/state/customers/customers.reducer';

export const selectCustomersState = createFeatureSelector<CustomersState>(customersFeatureKey);

export const selectCustomersData = createSelector(selectCustomersState, state => state.data);

export const selectCustomersTotal = createSelector(selectCustomersState, state => state.total);

export const selectCustomersLoading = createSelector(selectCustomersState, state => state.loading);

export const selectCustomersError = createSelector(selectCustomersState, state => state.error);

/** Params of the last list load — consumed by the A4 delete→reload effect. */
export const selectCustomersLastParams = createSelector(
  selectCustomersState,
  state => state.lastParams,
);

export const selectCustomersDeleting = createSelector(
  selectCustomersState,
  state => state.deleting,
);

export const selectCustomersDeletingId = createSelector(
  selectCustomersState,
  state => state.deletingId,
);

export const selectCustomersDeleteError = createSelector(
  selectCustomersState,
  state => state.deleteError,
);
