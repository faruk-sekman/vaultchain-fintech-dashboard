/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from '@core/api/api-client.service';
import {
  Address,
  Customer,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  KycStatus,
} from '@shared/models/customer.model';
import { PaginatedResponse } from '@shared/models/pagination.model';
import { HttpParamsInput } from '@shared/utils/http-params.util';

export interface ListCustomersParams extends HttpParamsInput {
  page?: number;
  pageSize?: number;
  search?: string;
  kycStatus?: KycStatus;
  isActive?: boolean;
  /**
   * Request UNMASKED PII. When `true`, `reveal=true` is appended to the wire
   * query; the server returns raw PII ONLY if the principal holds `customers.pii.reveal`, else it stays
   * masked (fail-closed) — this flag is just the ASK. Omitted/false ⇒ no param ⇒ unchanged masked request.
   */
  reveal?: boolean;
}

export interface ListKycVerificationsParams extends HttpParamsInput {
  page?: number;
  pageSize?: number;
}

export interface KycVerification {
  id: string;
  customerId: string;
  status: KycStatus;
  method: string;
  reasonCode: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export interface CredentialPreview {
  '@context': string[];
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    kycVerified: boolean;
  };
}

type BackendKycStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'IN_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'EXPIRED';

type BackendCustomerStatus = 'ACTIVE' | 'INACTIVE' | 'CLOSED';

interface BackendPage {
  number: number;
  size: number;
  totalItems: number;
  totalPages: number;
}

interface BackendCustomerListItem {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  walletNumber: string | null;
  nationalIdLast4: string | null;
  kycStatus: BackendKycStatus;
  status: BackendCustomerStatus;
  createdAt: string;
  updatedAt: string;
}

interface BackendCustomerDetail extends BackendCustomerListItem {
  dateOfBirth: string | null;
  address: {
    country: string | null;
    city: string | null;
    postalCode: string | null;
    line1: string | null;
  };
  rowVersion: number;
}

interface BackendAddress {
  country?: string;
  city?: string;
  postalCode?: string;
  line1?: string;
}

interface BackendCreateCustomer {
  fullName: string;
  email: string;
  phone?: string;
  nationalId: string;
  dateOfBirth?: string;
  address?: BackendAddress;
}

interface BackendUpdateCustomer {
  fullName?: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  address?: BackendAddress;
  kycStatus?: BackendKycStatus;
  status?: BackendCustomerStatus;
  rowVersion: number;
}

interface BackendPaginatedCustomers {
  data: BackendCustomerListItem[];
  page: BackendPage;
}

interface BackendEnvelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class CustomersApi {
  constructor(private readonly api: ApiClientService) {}

  list(params: ListCustomersParams): Observable<PaginatedResponse<Customer>> {
    return this.api
      .get<BackendPaginatedCustomers>('/customers', toBackendListParams(params))
      .pipe(map(toPaginatedCustomers));
  }

  getById(id: string, opts: { reveal?: boolean } = {}): Observable<Customer> {
    // `reveal=true` is appended only when explicitly requested; the server is the authority on whether
    // it actually unmasks. Omitted ⇒ masked request, unchanged from before.
    return this.api
      .get<BackendEnvelope<BackendCustomerDetail>>(`/customers/${encodeURIComponent(id)}`, {
        reveal: opts.reveal ? true : undefined,
      })
      .pipe(map(response => toCustomer(response.data)));
  }

  /**
   * Server-side paginated KYC verification history: `{ data, page }` envelope,
   * newest-first. Mirrors the transactions paging shape so every detail-tab pager is identical.
   */
  listKycVerifications(
    id: string,
    params: ListKycVerificationsParams = {},
  ): Observable<PaginatedResponse<KycVerification>> {
    return this.api
      .get<{
        data: KycVerification[];
        page: BackendPage;
      }>(`/customers/${encodeURIComponent(id)}/kyc-verifications`, {
        'page[number]': params.page,
        'page[size]': params.pageSize,
      })
      .pipe(
        map(response => ({
          data: response.data,
          page: response.page.number,
          pageSize: response.page.size,
          total: response.page.totalItems,
        })),
      );
  }

  getCredentialPreview(id: string): Observable<CredentialPreview> {
    return this.api
      .get<
        BackendEnvelope<CredentialPreview>
      >(`/customers/${encodeURIComponent(id)}/credential-preview`)
      .pipe(map(response => response.data));
  }

  create(payload: CreateCustomerRequest): Observable<Customer> {
    return this.api
      .post<BackendEnvelope<BackendCustomerDetail>>('/customers', toBackendCreate(payload))
      .pipe(map(response => toCustomer(response.data)));
  }

  update(id: string, payload: UpdateCustomerRequest): Observable<Customer> {
    return this.api
      .put<
        BackendEnvelope<BackendCustomerDetail>
      >(`/customers/${encodeURIComponent(id)}`, toBackendUpdate(payload))
      .pipe(map(response => toCustomer(response.data)));
  }

  delete(id: string): Observable<void> {
    return this.api.delete<void>(`/customers/${encodeURIComponent(id)}`);
  }
}

function toBackendAddress(address: Address): BackendAddress {
  const trim = (v: string | undefined): string | undefined =>
    v && v.trim() ? v.trim() : undefined;
  return {
    country: trim(address?.country),
    city: trim(address?.city),
    postalCode: trim(address?.postalCode),
    line1: trim(address?.line1),
  };
}

function toBackendCreate(payload: CreateCustomerRequest): BackendCreateCustomer {
  return {
    fullName: payload.name,
    email: payload.email,
    phone: payload.phone && payload.phone.trim() ? payload.phone.trim() : undefined,
    nationalId: String(payload.nationalId),
    dateOfBirth: payload.dateOfBirth || undefined,
    address: toBackendAddress(payload.address),
  };
}

function toBackendUpdate(payload: UpdateCustomerRequest): BackendUpdateCustomer {
  // Only forward the fields the form actually included (changed). Omitted fields preserve the
  // stored value — this is what keeps masked name/email/phone from round-tripping back. National
  // ID is immutable on the backend, so it is never sent.
  const body: BackendUpdateCustomer = { rowVersion: payload.rowVersion };
  if (payload.name !== undefined) body.fullName = payload.name;
  if (payload.email !== undefined) body.email = payload.email;
  if (payload.phone !== undefined)
    body.phone = payload.phone.trim() ? payload.phone.trim() : undefined;
  if (payload.dateOfBirth !== undefined) body.dateOfBirth = payload.dateOfBirth || undefined;
  if (payload.address !== undefined) body.address = toBackendAddress(payload.address);
  if (payload.kycStatus) body.kycStatus = payload.kycStatus;
  if (payload.isActive !== undefined) body.status = payload.isActive ? 'ACTIVE' : 'INACTIVE';
  return body;
}

function toBackendListParams(params: ListCustomersParams): HttpParamsInput {
  // Unified active/passive taxonomy: send `filter[active]` (true/false/undefined)
  // so the backend resolves passive = `status <> 'ACTIVE'` (INACTIVE+CLOSED) — matching the dashboard
  // summary's inactiveCount. The FE route query-param name (`isActive`) is unchanged; only the wire
  // param changes. The exact `filter[status]` capability stays available for power use.
  return {
    'page[number]': params.page,
    'page[size]': params.pageSize,
    'filter[q]': params.search,
    'filter[kycStatus]': params.kycStatus,
    'filter[active]': params.isActive,
    // Request-only, non-persisted: append `reveal=true` ONLY when truthy; masked default omits it.
    reveal: params.reveal ? true : undefined,
  };
}

function toPaginatedCustomers(response: BackendPaginatedCustomers): PaginatedResponse<Customer> {
  return {
    data: response.data.map(toCustomer),
    page: response.page.number,
    pageSize: response.page.size,
    total: response.page.totalItems,
  };
}

function toCustomer(customer: BackendCustomerListItem | BackendCustomerDetail): Customer {
  const detail = 'dateOfBirth' in customer ? customer : null;

  return {
    id: customer.id,
    name: customer.fullName,
    email: customer.email,
    phone: customer.phone ?? '',
    walletNumber: customer.walletNumber ?? '',
    dateOfBirth: detail?.dateOfBirth ?? '',
    // Keep the masked last-4 as the backend's string so a leading zero survives (Number('0930') => 930).
    // null/undefined → '' so the UI shows a blank, not a bogus 0.
    nationalId: customer.nationalIdLast4 ?? '',
    address: {
      country: detail?.address.country ?? '',
      city: detail?.address.city ?? '',
      postalCode: detail?.address.postalCode ?? '',
      line1: detail?.address.line1 ?? '',
    },
    kycStatus: customer.kycStatus,
    isActive: customer.status === 'ACTIVE',
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    rowVersion: detail?.rowVersion,
  };
}
