/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { provideState } from '@ngrx/store';
import { provideEffects } from '@ngrx/effects';

import {
  customersFeatureKey,
  customersReducer,
} from '@features/customers/state/customers/customers.reducer';
import { CustomersEffects } from '@features/customers/state/customers/customers.effects';
import {
  transactionsFeatureKey,
  transactionsReducer,
} from '@features/customers/state/transactions/transactions.reducer';
import { TransactionsEffects } from '@features/customers/state/transactions/transactions.effects';
import {
  kycVerificationsFeatureKey,
  kycVerificationsReducer,
} from '@features/customers/state/kyc-verifications/kyc-verifications.reducer';
import { KycVerificationsEffects } from '@features/customers/state/kyc-verifications/kyc-verifications.effects';

/**
 * Route-level NgRx providers for the customers feature (O-6): the `customers` (list + delete),
 * `transactions` (detail) and `kycVerifications` (detail) slices + their effects. Registered once
 * on the customers lazy route so all customer pages share them and none instantiate at bootstrap.
 */
export function provideCustomersState(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideState(customersFeatureKey, customersReducer),
    provideState(transactionsFeatureKey, transactionsReducer),
    provideState(kycVerificationsFeatureKey, kycVerificationsReducer),
    provideEffects(CustomersEffects, TransactionsEffects, KycVerificationsEffects),
  ]);
}
