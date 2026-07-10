/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Store } from '@ngrx/store';

import { ListKycVerificationsParams } from '@core/api/customers.api';
import { loadKycVerifications } from '@features/customers/state/kyc-verifications/kyc-verifications.actions';
import {
  selectKycVerificationsData,
  selectKycVerificationsLoading,
  selectKycVerificationsTotal,
} from '@features/customers/state/kyc-verifications/kyc-verifications.selectors';

@Injectable({ providedIn: 'root' })
export class KycVerificationsStore {
  private readonly store = inject(Store);

  readonly data$ = this.store.select(selectKycVerificationsData);
  readonly total$ = this.store.select(selectKycVerificationsTotal);
  readonly loading$ = this.store.select(selectKycVerificationsLoading);

  load(customerId: string, params: ListKycVerificationsParams) {
    this.store.dispatch(loadKycVerifications({ customerId, params }));
  }
}
