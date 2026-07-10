/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';

import {
  loadLatestCustomer,
  loadRecentCustomers,
} from '@features/dashboard/state/latest-customer.actions';
import {
  selectLatestCustomer,
  selectLatestCustomerError,
  selectLatestCustomerLoaded,
  selectLatestCustomerLoading,
  selectRecentCustomers,
  selectRecentCustomersError,
  selectRecentCustomersLoaded,
  selectRecentCustomersLoading,
} from '@features/dashboard/state/latest-customer.selectors';

@Injectable({ providedIn: 'root' })
export class LatestCustomerStore {
  private readonly store = inject(Store);

  readonly latest$ = this.store.select(selectLatestCustomer);
  readonly loading$ = this.store.select(selectLatestCustomerLoading);
  readonly loaded$ = this.store.select(selectLatestCustomerLoaded);
  readonly error$ = this.store.select(selectLatestCustomerError);

  /** v2.1 §5 "Recent Customers" — dedicated latest-customer endpoint (masked). */
  readonly recent$ = this.store.select(selectRecentCustomers);
  readonly recentLoading$ = this.store.select(selectRecentCustomersLoading);
  readonly recentLoaded$ = this.store.select(selectRecentCustomersLoaded);
  readonly recentError$ = this.store.select(selectRecentCustomersError);

  load() {
    this.store.dispatch(loadLatestCustomer());
  }

  loadRecent() {
    this.store.dispatch(loadRecentCustomers());
  }
}
