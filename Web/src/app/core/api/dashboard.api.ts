/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dashboard aggregates client: consumes the backend `/api/v1/dashboard/*`
 * server-side KPIs (envelope `{ data }`), retiring the browser-side computation that fetched only
 * pageSize:60 customers. Types mirror the backend DTOs (api-endpoint-specifications §6); the KYC
 * status is the BACKEND enum (NOT_STARTED/PENDING/IN_REVIEW/VERIFIED/REJECTED/EXPIRED).
 */
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from '@core/api/api-client.service';

export interface AgeStats {
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface DashboardSummary {
  totalCustomers: number;
  activeCount: number;
  inactiveCount: number;
  activeRate: number;
  inactiveRate: number;
  ageStats: AgeStats | null;
  asOf: string;
}

export interface KycDistributionItem {
  status: string;
  count: number;
  percent: number;
}

export interface KycDistribution {
  items: KycDistributionItem[];
  total: number;
  asOf: string;
}

export interface DashboardCustomer {
  id: string;
  fullName: string;
  email: string; // masked by the backend
  phone: string | null; // masked by the backend
  kycStatus: string;
  status: string;
  riskLevel: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWallet {
  currency: string;
  // Money minor-units as a JSON string of the exact integer. Carried through the
  // latest-customer state but not currently rendered as an amount; parse via parseMinor if displayed.
  balanceMinor: string;
}

export interface LatestCustomer {
  customer: DashboardCustomer;
  wallet: DashboardWallet | null;
}

/** A realtime dashboard signal pushed over SSE. PII-free: the client re-fetches masked aggregates. */
export interface DashboardEvent {
  type: 'customer.created' | 'customer.updated' | 'customer.deleted';
  customerId: string;
  at: string;
}

@Injectable({ providedIn: 'root' })
export class DashboardApi {
  private readonly api = inject(ApiClientService);

  getSummary(): Observable<DashboardSummary> {
    return this.api.get<{ data: DashboardSummary }>('/dashboard/summary').pipe(map(r => r.data));
  }

  getKycDistribution(): Observable<KycDistribution> {
    return this.api
      .get<{ data: KycDistribution }>('/dashboard/kyc-distribution')
      .pipe(map(r => r.data));
  }

  /** `data` is null (HTTP 200) when there are no customers. */
  getLatestCustomer(): Observable<LatestCustomer | null> {
    return this.api
      .get<{ data: LatestCustomer | null }>('/dashboard/latest-customer')
      .pipe(map(r => r.data));
  }

  /** The N most-recent customers (PII masked, newest first) for the "Recent Customers" list. */
  getRecentCustomers(limit = 3): Observable<DashboardCustomer[]> {
    return this.api
      .get<{ data: DashboardCustomer[] }>('/dashboard/recent-customers', { limit })
      .pipe(map(r => r.data));
  }

  /**
   * Authorize the realtime SSE stream. The backend sets a
   * short-lived, minimally-scoped httpOnly cookie (`ftd_stream`) the browser stores and replays on the
   * EventSource handshake — so NO token is placed in the URL (a token in the URL leaks via logs,
   * history, and the `Referer` header). `withCredentials:true` lets the browser store the Set-Cookie
   * cross-origin; the 204 response carries no body (the credential is never exposed to JS).
   */
  authorizeStream(): Observable<void> {
    return this.api
      .post<void>('/dashboard/stream-token', {}, { withCredentials: true })
      .pipe(map(() => undefined));
  }
}
