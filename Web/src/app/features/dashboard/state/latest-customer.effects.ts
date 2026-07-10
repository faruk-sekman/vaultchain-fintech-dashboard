/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, map, switchMap } from 'rxjs/operators';
import { of } from 'rxjs';

import { DashboardApi, DashboardCustomer } from '@core/api/dashboard.api';
import { Customer } from '@shared/models/customer.model';
import {
  loadLatestCustomer,
  loadLatestCustomerFailure,
  loadLatestCustomerSuccess,
  loadRecentCustomers,
  loadRecentCustomersFailure,
  loadRecentCustomersSuccess,
} from '@features/dashboard/state/latest-customer.actions';

@Injectable()
export class LatestCustomerEffects {
  private readonly actions$ = inject(Actions);
  private readonly api = inject(DashboardApi);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadLatestCustomer),
      switchMap(() =>
        this.api.getLatestCustomer().pipe(
          map(latest => loadLatestCustomerSuccess({ latest })),
          catchError(error => of(loadLatestCustomerFailure({ error }))),
        ),
      ),
    ),
  );

  /** Recent card is backed by the dedicated /dashboard/recent-customers endpoint (top 3, masked). */
  loadRecent$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadRecentCustomers),
      switchMap(() =>
        this.api.getRecentCustomers(3).pipe(
          map(customers => loadRecentCustomersSuccess({ customers: customers.map(toCustomer) })),
          catchError(error => of(loadRecentCustomersFailure({ error }))),
        ),
      ),
    ),
  );
}

function toCustomer(c: DashboardCustomer): Customer {
  return {
    id: c.id,
    name: c.fullName,
    email: c.email,
    phone: c.phone ?? '',
    walletNumber: '',
    dateOfBirth: '',
    nationalId: '',
    address: { country: '', city: '', postalCode: '', line1: '' },
    kycStatus: c.kycStatus as Customer['kycStatus'],
    isActive: c.status === 'ACTIVE',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
