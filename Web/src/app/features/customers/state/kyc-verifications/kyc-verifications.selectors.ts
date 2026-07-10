/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createFeatureSelector, createSelector } from '@ngrx/store';
import {
  KycVerificationsState,
  kycVerificationsFeatureKey,
} from '@features/customers/state/kyc-verifications/kyc-verifications.reducer';

export const selectKycVerificationsState = createFeatureSelector<KycVerificationsState>(
  kycVerificationsFeatureKey,
);

export const selectKycVerificationsData = createSelector(
  selectKycVerificationsState,
  state => state.data,
);

export const selectKycVerificationsTotal = createSelector(
  selectKycVerificationsState,
  state => state.total,
);

export const selectKycVerificationsLoading = createSelector(
  selectKycVerificationsState,
  state => state.loading,
);

export const selectKycVerificationsError = createSelector(
  selectKycVerificationsState,
  state => state.error,
);
