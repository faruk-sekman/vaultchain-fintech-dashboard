/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, concatMap, filter, map, switchMap, tap, withLatestFrom } from 'rxjs/operators';
import { of } from 'rxjs';
import { CustomersApi } from '@core/api/customers.api';
import {
  deleteCustomer,
  deleteCustomerFailure,
  deleteCustomerSuccess,
  loadCustomers,
  loadCustomersFailure,
  loadCustomersSuccess,
} from '@features/customers/state/customers/customers.actions';
import { selectCustomersLastParams } from '@features/customers/state/customers/customers.selectors';
import { ToastService } from '@core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';

@Injectable()
export class CustomersEffects {
  private readonly actions$ = inject(Actions);
  private readonly store = inject(Store);
  private readonly api = inject(CustomersApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadCustomers),
      switchMap(({ params }) =>
        this.api.list(params).pipe(
          map(res => loadCustomersSuccess({ data: res.data ?? [], total: res.total ?? 0 })),
          catchError(error => of(loadCustomersFailure({ error }))),
        ),
      ),
    ),
  );

  delete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(deleteCustomer),
      concatMap(({ id }) =>
        this.api.delete(id).pipe(
          map(() => deleteCustomerSuccess({ id })),
          catchError(error => of(deleteCustomerFailure({ id, error }))),
        ),
      ),
    ),
  );

  deleteSuccessToast$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(deleteCustomerSuccess),
        tap(() => this.toast.success(this.i18n.instant('customers.deleted'))),
      ),
    { dispatch: false },
  );

  /**
   * A4 (bugfix-backlog-2026-07): the post-delete list refresh is a STORE concern, not a component
   * chore — deleteCustomerSuccess re-dispatches loadCustomers with the exact params of the current
   * view (tracked by the reducer on every load), so totals/pagination re-sync server-side and no
   * component has to hand-wire the reload. The other CRUD surfaces are covered elsewhere:
   * customers list live-reloads via SSE on any mutation, dashboard KPIs/recents + the notification
   * badge ride their SSE streams, tx-create refetch is guaranteed in-component (A5), and a wallet
   * limit save emits the fresh wallet upward.
   */
  reloadAfterDelete$ = createEffect(() =>
    this.actions$.pipe(
      ofType(deleteCustomerSuccess),
      withLatestFrom(this.store.select(selectCustomersLastParams)),
      filter(([, params]) => params !== null),
      map(([, params]) => loadCustomers({ params: params! })),
    ),
  );
}
