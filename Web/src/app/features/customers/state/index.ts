/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

// Facade-only barrel: components consume the stores, never actions/selectors directly.
export { CustomersStore } from '@features/customers/state/customers/customers.store';
export { TransactionsStore } from '@features/customers/state/transactions/transactions.store';
export { KycVerificationsStore } from '@features/customers/state/kyc-verifications/kyc-verifications.store';
