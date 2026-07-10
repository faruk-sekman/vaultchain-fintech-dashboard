/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Transactions API. `listByCustomerId` consumes the migrated backend
 * `GET /customers/:id/transactions`: bracketed params, a REQUIRED date range, and
 * a signed `amountMinor` per transaction (CREDIT > 0, DEBIT < 0). Filtering is by the REAL backend
 * ledger dimensions — `kind`/`status`/`currency` + date range — which is what the server actually
 * supports; the signed amount still drives the displayed credit/debit colour.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from '@core/api/api-client.service';
import { minorToMajor, parseMinor } from '@shared/utils/money';
import { PaginatedResponse } from '@shared/models/pagination.model';
import {
  Transaction,
  TransactionKind,
  TransactionStatus,
  TransactionType,
  TransferDirection,
} from '@shared/models/transaction.model';
import { HttpParamsInput } from '@shared/utils/http-params.util';

export interface ListTransactionsParams extends HttpParamsInput {
  page?: number;
  pageSize?: number;
  kind?: TransactionKind;
  status?: TransactionStatus;
  currency?: string;
  from?: string;
  to?: string;
}

export interface CreateTransactionRequest {
  kind: TransactionKind;
  sourceWalletId?: string;
  targetWalletId?: string;
  originalTransactionId?: string;
  amountMinor: number;
  currency: string;
  categoryId?: string;
  description?: string;
}

export interface TransactionSnapshot {
  id: string;
  publicRef: string;
  status: 'POSTED';
  // Read-response money: a JSON string of the exact integer minor-units.
  amountMinor: string;
  currency: string;
  postedAt: string;
}

interface BackendPage {
  number: number;
  size: number;
  totalItems: number;
  totalPages: number;
}

interface BackendTransactionListItem {
  id: string;
  publicRef: string | null;
  kind: string;
  status: string;
  // Signed money minor-units as a JSON string of the exact integer; parsed via parseMinor.
  amountMinor: string;
  currency: string;
  description: string | null;
  occurredAt: string;
  postedAt: string | null;
}

interface BackendPaginatedTransactions {
  data: BackendTransactionListItem[];
  page: BackendPage;
}

@Injectable({ providedIn: 'root' })
export class TransactionsApi {
  constructor(private readonly api: ApiClientService) {}

  listByCustomerId(
    customerId: string,
    params: ListTransactionsParams,
  ): Observable<PaginatedResponse<Transaction>> {
    return this.api
      .get<BackendPaginatedTransactions>(
        `/customers/${encodeURIComponent(customerId)}/transactions`,
        toBackendTxParams(params),
      )
      .pipe(map(response => toPaginatedTransactions(customerId, response)));
  }

  create(body: CreateTransactionRequest, idempotencyKey: string): Observable<TransactionSnapshot> {
    return this.api
      .post<{ data: TransactionSnapshot }>('/transactions', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      })
      .pipe(map(response => response.data));
  }
}

function toBackendTxParams(params: ListTransactionsParams): HttpParamsInput {
  return {
    'page[number]': params.page,
    'page[size]': params.pageSize,
    'filter[occurredFrom]': params.from,
    'filter[occurredTo]': params.to,
    'filter[kind]': params.kind,
    'filter[status]': params.status,
    'filter[currency]': params.currency,
  };
}

function toPaginatedTransactions(
  customerId: string,
  response: BackendPaginatedTransactions,
): PaginatedResponse<Transaction> {
  return {
    data: response.data.map(tx => toTransaction(customerId, tx)),
    page: response.page.number,
    pageSize: response.page.size,
    total: response.page.totalItems,
  };
}

function toTransaction(customerId: string, tx: BackendTransactionListItem): Transaction {
  const amountMinor = parseMinor(tx.amountMinor, 'amountMinor');
  const isCredit = amountMinor >= 0;
  const type: TransactionType = isCredit ? 'CREDIT' : 'DEBIT';
  const transferDirection: TransferDirection = isCredit ? 'INCOMING' : 'OUTGOING';
  return {
    id: tx.id,
    customerId,
    kind: tx.kind as TransactionKind,
    status: tx.status as TransactionStatus,
    type,
    amount: minorToMajor(Math.abs(amountMinor)),
    currency: tx.currency,
    createdAt: tx.occurredAt,
    description: tx.description ?? tx.publicRef ?? '',
    transferDirection,
  };
}
