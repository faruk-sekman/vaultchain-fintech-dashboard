/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createAction, props } from '@ngrx/store';
import { Customer } from '@shared/models/customer.model';
import { ListCustomersParams } from '@core/api/customers.api';

export const loadCustomers = createAction(
  '[Customers] Load',
  props<{ params: ListCustomersParams }>(),
);

export const loadCustomersSuccess = createAction(
  '[Customers] Load Success',
  props<{ data: Customer[]; total: number }>(),
);

export const loadCustomersFailure = createAction(
  '[Customers] Load Failure',
  props<{ error: unknown }>(),
);

export const deleteCustomer = createAction('[Customers] Delete', props<{ id: string }>());

export const deleteCustomerSuccess = createAction(
  '[Customers] Delete Success',
  props<{ id: string }>(),
);

export const deleteCustomerFailure = createAction(
  '[Customers] Delete Failure',
  props<{ id: string; error: unknown }>(),
);
