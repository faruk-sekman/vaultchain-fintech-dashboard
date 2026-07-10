/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { CustomersApi } from '@core/api/customers.api';
import { CatalogApi } from '@core/api/catalog.api';
import { HealthApi } from '@core/api/health.api';
import { MetricsApi } from '@core/api/metrics.api';
import { OperatorApi } from '@core/api/operator.api';
import { RbacApi } from '@core/api/rbac.api';
import { TransactionsApi } from '@core/api/transactions.api';
import { WalletsApi } from '@core/api/wallets.api';
import { lastValueFrom, of } from 'rxjs';

class ApiClientMock {
  get = vi.fn(() => of({}));
  post = vi.fn(() => of({}));
  put = vi.fn(() => of({}));
  patch = vi.fn(() => of({}));
  delete = vi.fn(() => of({}));
}

describe('API wrappers', () => {
  it('CustomersApi uses correct endpoints and adapts the backend list contract', async () => {
    const apiClient = new ApiClientMock();
    apiClient.get.mockReturnValueOnce(
      of({
        data: [
          {
            id: '1',
            fullName: 'Ada L***',
            email: 'a***@e***.com',
            phone: '*** *** 1234',
            walletNumber: '************3456',
            nationalIdLast4: '7890',
            kycStatus: 'VERIFIED',
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        page: { number: 1, size: 10, totalItems: 750, totalPages: 75 },
      }),
    );
    const api = new CustomersApi(apiClient as any);

    const list = await lastValueFrom(
      api.list({ page: 1, pageSize: 10, search: 'ada', isActive: true }),
    );
    expect(apiClient.get).toHaveBeenCalledWith(
      '/customers',
      expect.objectContaining({
        'page[number]': 1,
        'page[size]': 10,
        'filter[q]': 'ada',
        // Unified active/passive taxonomy: the boolean is sent as `filter[active]`
        // (the backend resolves passive = `status <> 'ACTIVE'`), NOT a derived `filter[status]`.
        'filter[active]': true,
      }),
    );
    expect(list.total).toBe(750);
    expect(list.data[0].name).toBe('Ada L***');
    expect(list.data[0].kycStatus).toBe('VERIFIED');
    expect(list.data[0].isActive).toBe(true);
    // nationalId is the masked last-4 kept as a STRING (no Number() coercion).
    expect(list.data[0].nationalId).toBe('7890');

    apiClient.get.mockReturnValueOnce(
      of({
        data: {
          id: 'id 1',
          fullName: 'Ada L***',
          email: 'a***@e***.com',
          phone: null,
          walletNumber: null,
          nationalIdLast4: null,
          kycStatus: 'NOT_STARTED',
          status: 'INACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          dateOfBirth: null,
          address: { country: null, city: null, postalCode: null, line1: null },
        },
      }),
    );

    const detail = await lastValueFrom(api.getById('id 1'));
    // getById now passes a params object carrying the optional reveal flag; a masked default
    // read sends `reveal: undefined`, so no `reveal` param reaches the wire.
    expect(apiClient.get).toHaveBeenCalledWith('/customers/id%201', { reveal: undefined });
    expect(detail.kycStatus).toBe('NOT_STARTED'); // real backend enum, no FE collapsing
    expect(detail.nationalId).toBe(''); // null last-4 → blank string, never a bogus 0

    apiClient.get.mockReturnValueOnce(
      of({
        data: {
          '@context': ['https://www.w3.org/2018/credentials/v1'],
          type: ['VerifiableCredential', 'KycCredential'],
          issuer: 'did:example:fintech-ops-compliance',
          issuanceDate: '2026-06-12T00:00:00.000Z',
          credentialSubject: { id: 'did:example:id 1', kycVerified: false },
        },
      }),
    );
    const credential = await lastValueFrom(api.getCredentialPreview('id 1'));
    expect(apiClient.get).toHaveBeenCalledWith('/customers/id%201/credential-preview');
    expect(credential.credentialSubject.kycVerified).toBe(false);

    const backendDetail = {
      id: 'c9',
      fullName: 'Ada L***',
      email: 'a***@e***.com',
      phone: '*** *** 2233',
      walletNumber: null,
      nationalIdLast4: '0146',
      kycStatus: 'NOT_STARTED',
      status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      dateOfBirth: '1990-01-04',
      address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
      rowVersion: 0,
    };

    // create: translates the FE shape → backend DTO (name→fullName, nationalId→string) and unwraps {data}.
    apiClient.post.mockReturnValueOnce(of({ data: backendDetail }));
    const created = await lastValueFrom(
      api.create({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+90 555 111 2233',
        dateOfBirth: '1990-01-04',
        nationalId: 10000000146,
        address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
      }),
    );
    expect(apiClient.post).toHaveBeenCalledWith('/customers', {
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+90 555 111 2233',
      nationalId: '10000000146',
      dateOfBirth: '1990-01-04',
      address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
    });
    expect(created.name).toBe('Ada L***');
    expect(created.rowVersion).toBe(0);
    // A leading-zero last-4 survives intact (would become 146 if coerced to Number).
    expect(created.nationalId).toBe('0146');

    // update: maps kyc/active → backend enums, drops nationalId, forwards rowVersion; unwraps {data}.
    apiClient.put.mockReturnValueOnce(of({ data: { ...backendDetail, rowVersion: 4 } }));
    const updated = await lastValueFrom(
      api.update('id', {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+90 555 111 2233',
        dateOfBirth: '1990-01-04',
        nationalId: 146,
        address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
        kycStatus: 'VERIFIED',
        isActive: true,
        rowVersion: 3,
      }),
    );
    expect(apiClient.put).toHaveBeenCalledWith('/customers/id', {
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+90 555 111 2233',
      dateOfBirth: '1990-01-04',
      address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: '1 Test St' },
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      rowVersion: 3,
    });
    expect(updated.rowVersion).toBe(4);

    api.delete('id').subscribe();
    expect(apiClient.delete).toHaveBeenCalledWith('/customers/id');
  });

  it('CustomersApi list maps isActive → filter[active] (true/false/undefined), never filter[status]', async () => {
    const apiClient = new ApiClientMock();
    const api = new CustomersApi(apiClient as any);
    const emptyPage = { data: [], page: { number: 1, size: 25, totalItems: 0, totalPages: 1 } };

    // isActive = false → filter[active] === false (passive = INACTIVE+CLOSED on the backend),
    // and the derived filter[status] is NOT sent.
    apiClient.get.mockReturnValueOnce(of(emptyPage));
    await lastValueFrom(api.list({ isActive: false }));
    const passiveArgs = apiClient.get.mock.calls[0][1] as Record<string, unknown>;
    expect(passiveArgs['filter[active]']).toBe(false);
    expect(passiveArgs).not.toHaveProperty('filter[status]');

    // isActive = true → filter[active] === true.
    apiClient.get.mockReturnValueOnce(of(emptyPage));
    await lastValueFrom(api.list({ isActive: true }));
    const activeArgs = apiClient.get.mock.calls[1][1] as Record<string, unknown>;
    expect(activeArgs['filter[active]']).toBe(true);
    expect(activeArgs).not.toHaveProperty('filter[status]');

    // isActive omitted → filter[active] is undefined (no tab filter applied).
    apiClient.get.mockReturnValueOnce(of(emptyPage));
    await lastValueFrom(api.list({ page: 1, pageSize: 25 }));
    const allArgs = apiClient.get.mock.calls[2][1] as Record<string, unknown>;
    expect(allArgs['filter[active]']).toBeUndefined();
    expect(allArgs).not.toHaveProperty('filter[status]');
  });

  it('TransactionsApi consumes the customer-scoped endpoint and maps signed amounts', async () => {
    const apiClient = new ApiClientMock();
    apiClient.get.mockReturnValueOnce(
      of({
        data: [
          {
            id: 't1',
            publicRef: 'TX-1',
            kind: 'DEPOSIT',
            status: 'POSTED',
            amountMinor: '100000',
            currency: 'TRY',
            description: 'Salary',
            occurredAt: '2026-03-01T00:00:00.000Z',
            postedAt: null,
          },
          {
            id: 't2',
            publicRef: 'TX-2',
            kind: 'WITHDRAWAL',
            status: 'POSTED',
            amountMinor: '-40000',
            currency: 'TRY',
            description: 'ATM',
            occurredAt: '2026-03-02T00:00:00.000Z',
            postedAt: null,
          },
        ],
        page: { number: 2, size: 10, totalItems: 12, totalPages: 2 },
      }),
    );
    const api = new TransactionsApi(apiClient as any);

    const res = await lastValueFrom(
      api.listByCustomerId('cust 1', {
        page: 2,
        pageSize: 10,
        from: '2026-01-01T00:00',
        to: '2026-06-01T00:00',
        currency: 'TRY',
      }),
    );
    expect(apiClient.get).toHaveBeenCalledWith(
      '/customers/cust%201/transactions',
      expect.objectContaining({
        'page[number]': 2,
        'page[size]': 10,
        'filter[occurredFrom]': '2026-01-01T00:00',
        'filter[occurredTo]': '2026-06-01T00:00',
        'filter[currency]': 'TRY',
      }),
    );
    expect(res.total).toBe(12);
    expect(res.data[0]).toMatchObject({
      type: 'CREDIT',
      transferDirection: 'INCOMING',
      amount: 1000,
    });
    expect(res.data[1]).toMatchObject({
      type: 'DEBIT',
      transferDirection: 'OUTGOING',
      amount: 400,
    });

    apiClient.post.mockReturnValueOnce(
      of({
        data: {
          id: 'tx-3',
          publicRef: 'TX-3',
          status: 'POSTED',
          amountMinor: '2500',
          currency: 'TRY',
          postedAt: '2026-03-03T00:00:00.000Z',
        },
      }),
    );
    const created = await lastValueFrom(
      api.create(
        {
          kind: 'DEPOSIT',
          targetWalletId: 'wallet-1',
          amountMinor: 2500,
          currency: 'TRY',
        },
        '00000000-0000-4000-8000-000000000001',
      ),
    );
    expect(apiClient.post).toHaveBeenCalledWith(
      '/transactions',
      {
        kind: 'DEPOSIT',
        targetWalletId: 'wallet-1',
        amountMinor: 2500,
        currency: 'TRY',
      },
      { headers: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000001' } },
    );
    expect(created.publicRef).toBe('TX-3');
  });

  it('WalletsApi consumes the customer-scoped wallet endpoint and maps minor→major', async () => {
    const apiClient = new ApiClientMock();
    const walletDetail = {
      id: 'w1',
      currency: 'TRY',
      balanceMinor: '123450',
      availableBalanceMinor: '120000',
      dailyLimitMinor: '500000',
      monthlyLimitMinor: '5000000',
      status: 'ACTIVE',
      rowVersion: 0,
    };
    const api = new WalletsApi(apiClient as any);

    apiClient.get.mockReturnValueOnce(of({ data: walletDetail }));
    const wallet = await lastValueFrom(api.getByCustomerId('cust 1'));
    expect(apiClient.get).toHaveBeenCalledWith('/customers/cust%201/wallet');
    expect(wallet.id).toBe('w1');
    expect(wallet.balance).toBe(1234.5);
    expect(wallet.dailyLimit).toBe(5000);
    expect(wallet.monthlyLimit).toBe(50000);
    expect(wallet.status).toBe('ACTIVE');
    expect(wallet.rowVersion).toBe(0);

    apiClient.patch.mockReturnValueOnce(of({ data: walletDetail }));
    await lastValueFrom(
      api.updateLimits('cust 1', { dailyLimit: 5000, monthlyLimit: 50000, rowVersion: 0 }),
    );
    expect(apiClient.patch).toHaveBeenCalledWith('/customers/cust%201/wallet', {
      dailyLimit: 5000,
      monthlyLimit: 50000,
      rowVersion: 0,
    });
  });

  it('MetricsApi consumes the daily metrics endpoint through the app API client', async () => {
    const apiClient = new ApiClientMock();
    apiClient.get.mockReturnValueOnce(
      of({
        data: {
          metric: 'customers_new_daily',
          items: [{ date: '2026-06-11', value: '3' }],
          asOf: '2026-06-11T12:00:00.000Z',
        },
      }),
    );
    const api = new MetricsApi(apiClient as any);

    const res = await lastValueFrom(
      api.getDaily({ metric: 'customers_new_daily', from: '2026-06-01', to: '2026-06-11' }),
    );

    expect(apiClient.get).toHaveBeenCalledWith('/metrics/daily', {
      metric: 'customers_new_daily',
      from: '2026-06-01',
      to: '2026-06-11',
    });
    expect(res.items).toEqual([{ date: '2026-06-11', value: '3' }]);
  });

  it('CatalogApi consumes the currency catalog endpoint', async () => {
    const apiClient = new ApiClientMock();
    apiClient.get.mockReturnValueOnce(
      of({ data: { items: [{ code: 'TRY', name: 'Turkish Lira', scale: 2 }] } }),
    );
    const api = new CatalogApi(apiClient as any);

    const res = await lastValueFrom(api.listCurrencies());

    expect(apiClient.get).toHaveBeenCalledWith('/catalog/currencies');
    expect(res[0].code).toBe('TRY');
  });

  it('OperatorApi consumes profile and notification-preferences endpoints', async () => {
    const apiClient = new ApiClientMock();
    const api = new OperatorApi(apiClient as any);

    apiClient.get.mockReturnValueOnce(
      of({
        data: { displayName: 'Operator', email: 'op@example.com', phone: null, jobTitle: 'Ops' },
      }),
    );
    await lastValueFrom(api.getProfile());
    expect(apiClient.get).toHaveBeenCalledWith('/operator/profile');

    apiClient.patch.mockReturnValueOnce(
      of({
        data: { displayName: 'Operator 2', email: 'op@example.com', phone: null, jobTitle: 'Risk' },
      }),
    );
    await lastValueFrom(api.updateProfile({ displayName: 'Operator 2', jobTitle: 'Risk' }));
    expect(apiClient.patch).toHaveBeenCalledWith('/operator/profile', {
      displayName: 'Operator 2',
      jobTitle: 'Risk',
    });

    apiClient.get.mockReturnValueOnce(
      of({ data: { productUpdates: true, securityAlerts: true, weeklyDigest: false } }),
    );
    await lastValueFrom(api.getNotificationPreferences());
    expect(apiClient.get).toHaveBeenCalledWith('/operator/notification-preferences');

    apiClient.patch.mockReturnValueOnce(
      of({ data: { productUpdates: false, securityAlerts: true, weeklyDigest: false } }),
    );
    await lastValueFrom(api.updateNotificationPreferences({ productUpdates: false }));
    expect(apiClient.patch).toHaveBeenCalledWith('/operator/notification-preferences', {
      productUpdates: false,
    });
  });

  it('RbacApi and HealthApi consume backend admin/status endpoints', async () => {
    const apiClient = new ApiClientMock();
    const rbac = new RbacApi(apiClient as any);
    const health = new HealthApi(apiClient as any);

    apiClient.get.mockReturnValueOnce(
      of({ data: { items: [{ id: 'r1', name: 'Admin', permissions: ['roles.read'] }] } }),
    );
    const roles = await lastValueFrom(rbac.listRoles());
    expect(apiClient.get).toHaveBeenCalledWith('/roles');
    expect(roles[0].permissions).toEqual(['roles.read']);

    apiClient.get.mockReturnValueOnce(of({ data: { items: [{ id: 'p1', code: 'roles.read' }] } }));
    const permissions = await lastValueFrom(rbac.listPermissions());
    expect(apiClient.get).toHaveBeenCalledWith('/permissions');
    expect(permissions[0].code).toBe('roles.read');

    apiClient.get.mockReturnValueOnce(of({ data: { status: 'ok', uptimeSeconds: 12 } }));
    const status = await lastValueFrom(health.getHealth());
    expect(apiClient.get).toHaveBeenCalledWith('/health');
    expect(status.uptimeSeconds).toBe(12);
  });
});
