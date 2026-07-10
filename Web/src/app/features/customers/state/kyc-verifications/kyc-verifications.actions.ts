/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createAction, props } from '@ngrx/store';
import { KycVerification, ListKycVerificationsParams } from '@core/api/customers.api';

export const loadKycVerifications = createAction(
  '[KycVerifications] Load',
  props<{ customerId: string; params: ListKycVerificationsParams }>(),
);

export const loadKycVerificationsSuccess = createAction(
  '[KycVerifications] Load Success',
  props<{ data: KycVerification[]; total: number }>(),
);

export const loadKycVerificationsFailure = createAction(
  '[KycVerifications] Load Failure',
  props<{ error: unknown }>(),
);
