/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createReducer, on } from '@ngrx/store';
import { KycVerification } from '@core/api/customers.api';
import {
  loadKycVerifications,
  loadKycVerificationsFailure,
  loadKycVerificationsSuccess,
} from '@features/customers/state/kyc-verifications/kyc-verifications.actions';

export const kycVerificationsFeatureKey = 'kycVerifications';

export interface KycVerificationsState {
  data: KycVerification[];
  total: number;
  loading: boolean;
  error: unknown | null;
}

export const initialState: KycVerificationsState = {
  data: [],
  total: 0,
  loading: false,
  error: null,
};

export const kycVerificationsReducer = createReducer(
  initialState,
  on(loadKycVerifications, state => ({ ...state, loading: true, error: null })),
  on(loadKycVerificationsSuccess, (state, { data, total }) => ({
    ...state,
    data,
    total,
    loading: false,
    error: null,
  })),
  on(loadKycVerificationsFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
);
