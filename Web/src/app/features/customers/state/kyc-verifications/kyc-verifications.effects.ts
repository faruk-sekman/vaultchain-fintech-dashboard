/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, map, switchMap } from 'rxjs/operators';
import { of } from 'rxjs';
import { CustomersApi } from '@core/api/customers.api';
import {
  loadKycVerifications,
  loadKycVerificationsFailure,
  loadKycVerificationsSuccess,
} from '@features/customers/state/kyc-verifications/kyc-verifications.actions';

@Injectable()
export class KycVerificationsEffects {
  private readonly actions$ = inject(Actions);
  private readonly api = inject(CustomersApi);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadKycVerifications),
      switchMap(({ customerId, params }) =>
        this.api.listKycVerifications(customerId, params).pipe(
          map(res => loadKycVerificationsSuccess({ data: res.data ?? [], total: res.total ?? 0 })),
          catchError(error => of(loadKycVerificationsFailure({ error }))),
        ),
      ),
    ),
  );
}
