/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, map, switchMap } from 'rxjs/operators';
import { of } from 'rxjs';
import { TransactionsApi } from '@core/api/transactions.api';
import {
  loadTransactions,
  loadTransactionsFailure,
  loadTransactionsSuccess,
} from '@features/customers/state/transactions/transactions.actions';

@Injectable()
export class TransactionsEffects {
  private readonly actions$ = inject(Actions);
  private readonly api = inject(TransactionsApi);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadTransactions),
      switchMap(({ customerId, params }) =>
        this.api.listByCustomerId(customerId, params).pipe(
          map(res => loadTransactionsSuccess({ data: res.data ?? [], total: res.total ?? 0 })),
          catchError(error => of(loadTransactionsFailure({ error }))),
        ),
      ),
    ),
  );
}
