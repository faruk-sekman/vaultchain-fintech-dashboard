/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Wallet API. `getByCustomerId` consumes the migrated backend `GET /customers/:id/wallet`:
 * the 1:1 default wallet, minor-units → major-units for display. `updateLimits`
 * PATCHes the customer-scoped `PATCH /customers/:id/wallet`, gated by
 * `wallets.manage-limits` and write-throttled — the endpoint is live, so saving limits is functional.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from '@core/api/api-client.service';
import { minorToMajor, parseMinor } from '@shared/utils/money';
import { UpdateWalletLimitsRequest, Wallet, WalletStatus } from '@shared/models/wallet.model';

interface BackendWalletDetail {
  id: string;
  currency: string;
  // Money minor-units arrive as JSON strings of the exact integer; parsed via parseMinor.
  balanceMinor: string;
  availableBalanceMinor: string;
  dailyLimitMinor: string;
  monthlyLimitMinor: string;
  status: WalletStatus;
  rowVersion: number;
}

interface BackendEnvelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class WalletsApi {
  constructor(private readonly api: ApiClientService) {}

  getByCustomerId(customerId: string): Observable<Wallet> {
    return this.api
      .get<
        BackendEnvelope<BackendWalletDetail>
      >(`/customers/${encodeURIComponent(customerId)}/wallet`)
      .pipe(map(response => toWallet(customerId, response.data)));
  }

  updateLimits(customerId: string, payload: UpdateWalletLimitsRequest): Observable<Wallet> {
    return this.api
      .patch<
        BackendEnvelope<BackendWalletDetail>
      >(`/customers/${encodeURIComponent(customerId)}/wallet`, payload)
      .pipe(map(response => toWallet(customerId, response.data)));
  }
}

function toWallet(customerId: string, wallet: BackendWalletDetail): Wallet {
  return {
    id: wallet.id,
    customerId,
    currency: wallet.currency,
    balance: minorToMajor(parseMinor(wallet.balanceMinor, 'balanceMinor')),
    dailyLimit: minorToMajor(parseMinor(wallet.dailyLimitMinor, 'dailyLimitMinor')),
    monthlyLimit: minorToMajor(parseMinor(wallet.monthlyLimitMinor, 'monthlyLimitMinor')),
    status: wallet.status,
    rowVersion: wallet.rowVersion,
  };
}
