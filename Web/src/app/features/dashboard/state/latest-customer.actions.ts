/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createAction, props } from '@ngrx/store';
import { LatestCustomer } from '@core/api/dashboard.api';
import { Customer } from '@shared/models/customer.model';

export const loadLatestCustomer = createAction('[Dashboard] Load Latest Customer');

export const loadLatestCustomerSuccess = createAction(
  '[Dashboard] Load Latest Customer Success',
  props<{ latest: LatestCustomer | null }>(),
);

export const loadLatestCustomerFailure = createAction(
  '[Dashboard] Load Latest Customer Failure',
  props<{ error: unknown }>(),
);

/**
 * v2.1 §5 row 1 "Recent Customers": the dedicated
 * `/dashboard/latest-customer` read model; fields arrive masked from the API.
 */
export const loadRecentCustomers = createAction('[Dashboard] Load Recent Customers');

export const loadRecentCustomersSuccess = createAction(
  '[Dashboard] Load Recent Customers Success',
  props<{ customers: Customer[] }>(),
);

export const loadRecentCustomersFailure = createAction(
  '[Dashboard] Load Recent Customers Failure',
  props<{ error: unknown }>(),
);
