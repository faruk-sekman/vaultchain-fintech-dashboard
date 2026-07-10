/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * CustomersApi reveal-param wiring + the TR/EN parity of the new
 * `customers.pii.*` i18n keys. The reveal flag is the single wire boundary: it must append
 * `reveal=true` ONLY when requested, and never widen the national-id (last-4 in all modes).
 */
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { CustomersApi, ListCustomersParams } from './customers.api';
import { ApiClientService } from '@core/api/api-client.service';
import type {
  CreateCustomerRequest,
  Customer,
  UpdateCustomerRequest,
} from '@shared/models/customer.model';
import enBundle from '../../../assets/i18n/en.json';
import trBundle from '../../../assets/i18n/tr.json';

const listResponse = {
  data: [
    {
      id: '1',
      fullName: 'Ada L***',
      email: 'a***@e***.com',
      phone: null,
      walletNumber: null,
      nationalIdLast4: '1234',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
      createdAt: '',
      updatedAt: '',
    },
  ],
  page: { number: 1, size: 25, totalItems: 1, totalPages: 1 },
};

const detailResponse = {
  data: {
    ...listResponse.data[0],
    dateOfBirth: null,
    address: { country: 'TR', city: null, postalCode: null, line1: '1***' },
    rowVersion: 0,
  },
};

function apiMock(response: unknown) {
  return { get: vi.fn(() => of(response)) } as unknown as ApiClientService & {
    get: ReturnType<typeof vi.fn>;
  };
}

describe('CustomersApi reveal wiring', () => {
  it('list({ reveal: true }) appends reveal=true to the wire query', () => {
    const api = apiMock(listResponse);
    new CustomersApi(api).list({ page: 1, reveal: true } as ListCustomersParams).subscribe();
    expect(api.get).toHaveBeenCalledWith('/customers', expect.objectContaining({ reveal: true }));
  });

  it('list without reveal omits the param (masked default request is unchanged)', () => {
    const api = apiMock(listResponse);
    new CustomersApi(api).list({ page: 1 } as ListCustomersParams).subscribe();
    expect(api.get.mock.calls[0][1].reveal).toBeUndefined();
  });

  it('getById(id, { reveal: true }) appends reveal=true; default getById(id) omits it', () => {
    const api = apiMock(detailResponse);
    const svc = new CustomersApi(api);
    svc.getById('1', { reveal: true }).subscribe();
    expect(api.get).toHaveBeenCalledWith('/customers/1', { reveal: true });

    api.get.mockClear();
    svc.getById('1').subscribe();
    expect(api.get).toHaveBeenCalledWith('/customers/1', { reveal: undefined });
  });

  it('keeps the national-id as last-4 regardless of reveal (D2 — never widened)', () => {
    const api = apiMock(detailResponse);
    let nationalId = 'unset';
    new CustomersApi(api)
      .getById('1', { reveal: true })
      .subscribe(c => (nationalId = c.nationalId as unknown as string));
    expect(nationalId).toBe('1234');
  });
});

/** A fuller mock exposing every verb so create/update/delete/list-kyc paths are reachable. */
function fullApiMock(response: unknown) {
  return {
    get: vi.fn(() => of(response)),
    post: vi.fn(() => of(response)),
    put: vi.fn(() => of(response)),
    delete: vi.fn(() => of(response)),
  } as unknown as ApiClientService & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

describe('CustomersApi.list — backend param + envelope mapping', () => {
  it('translates FE params into bracketed wire params and maps the page envelope', () => {
    const api = fullApiMock(listResponse);
    let result: { page: number; pageSize: number; total: number } | undefined;
    new CustomersApi(api)
      .list({ page: 2, pageSize: 25, search: 'ada', kycStatus: 'VERIFIED', isActive: false })
      .subscribe(r => (result = r));

    expect(api.get).toHaveBeenCalledWith('/customers', {
      'page[number]': 2,
      'page[size]': 25,
      'filter[q]': 'ada',
      'filter[kycStatus]': 'VERIFIED',
      'filter[active]': false,
      reveal: undefined,
    });
    // Page envelope is mapped from the backend `page` block (data shape covered separately).
    expect(result?.page).toBe(1);
    expect(result?.pageSize).toBe(25);
    expect(result?.total).toBe(1);
  });

  it('maps a list item with null phone/wallet to empty strings (toCustomer list-item branch)', () => {
    const api = fullApiMock(listResponse);
    let customer: Customer | undefined;
    new CustomersApi(api).list({}).subscribe(r => (customer = r.data[0]));
    // The list item carries no `dateOfBirth` → detail === null → address + dob default to ''.
    expect(customer?.phone).toBe('');
    expect(customer?.walletNumber).toBe('');
    expect(customer?.dateOfBirth).toBe('');
    expect(customer?.address).toEqual({ country: '', city: '', postalCode: '', line1: '' });
    expect(customer?.nationalId).toBe('1234');
    expect(customer?.isActive).toBe(true);
    expect(customer?.rowVersion).toBeUndefined();
  });
});

describe('CustomersApi.getById — detail mapping', () => {
  it('maps a detail (with address + rowVersion) and keeps a null last-4 as ""', () => {
    const api = fullApiMock({
      data: {
        ...detailResponse.data,
        nationalIdLast4: null,
        status: 'INACTIVE',
        address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: null },
      },
    });
    let customer: Customer | undefined;
    new CustomersApi(api).getById('1').subscribe(c => (customer = c));
    expect(customer?.nationalId).toBe(''); // null last-4 → '' (no bogus 0)
    expect(customer?.isActive).toBe(false); // status !== 'ACTIVE'
    expect(customer?.address.city).toBe('Istanbul');
    expect(customer?.address.line1).toBe(''); // null line1 → ''
    expect(customer?.rowVersion).toBe(0);
  });
});

describe('CustomersApi.listKycVerifications + getCredentialPreview', () => {
  it('maps the KYC verification page envelope and forwards page params', () => {
    const api = fullApiMock({
      data: [{ id: 'k1', customerId: '1', status: 'VERIFIED' }],
      page: { number: 1, size: 10, totalItems: 1, totalPages: 1 },
    });
    let result: { total: number; data: unknown[] } | undefined;
    new CustomersApi(api).listKycVerifications('1', { page: 1, pageSize: 10 }).subscribe(r => {
      result = r;
    });
    expect(api.get).toHaveBeenCalledWith('/customers/1/kyc-verifications', {
      'page[number]': 1,
      'page[size]': 10,
    });
    expect(result?.total).toBe(1);
    expect(result?.data).toHaveLength(1);
  });

  it('defaults the KYC params object when none is passed', () => {
    const api = fullApiMock({
      data: [],
      page: { number: 1, size: 25, totalItems: 0, totalPages: 0 },
    });
    new CustomersApi(api).listKycVerifications('1').subscribe();
    expect(api.get).toHaveBeenCalledWith('/customers/1/kyc-verifications', {
      'page[number]': undefined,
      'page[size]': undefined,
    });
  });

  it('unwraps the credential preview from { data }', () => {
    const preview = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      issuanceDate: '2026-01-01',
      credentialSubject: { id: 'did:example:1', kycVerified: true },
    };
    const api = fullApiMock({ data: preview });
    let out: unknown;
    new CustomersApi(api).getCredentialPreview('1').subscribe(p => (out = p));
    expect(api.get).toHaveBeenCalledWith('/customers/1/credential-preview');
    expect(out).toEqual(preview);
  });
});

describe('CustomersApi.create — request mapping (toBackendCreate/toBackendAddress)', () => {
  it('trims phone + address and maps the FE field names; sends nationalId as a string', () => {
    const api = fullApiMock(detailResponse);
    const payload: CreateCustomerRequest = {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '  +90 555  ',
      nationalId: '12345678901' as unknown as CreateCustomerRequest['nationalId'],
      dateOfBirth: '1990-01-01',
      address: { country: ' TR ', city: '', postalCode: '  ', line1: 'Main St' },
    };
    new CustomersApi(api).create(payload).subscribe();
    expect(api.post).toHaveBeenCalledWith('/customers', {
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '+90 555', // trimmed
      nationalId: '12345678901', // stringified
      dateOfBirth: '1990-01-01',
      address: { country: 'TR', city: undefined, postalCode: undefined, line1: 'Main St' },
    });
  });

  it('drops blank phone/dateOfBirth to undefined (falsy branches)', () => {
    const api = fullApiMock(detailResponse);
    const payload: CreateCustomerRequest = {
      name: 'No Phone',
      email: 'np@example.com',
      phone: '   ',
      nationalId: '99999999999' as unknown as CreateCustomerRequest['nationalId'],
      dateOfBirth: '',
      address: { country: '', city: '', postalCode: '', line1: '' },
    };
    new CustomersApi(api).create(payload).subscribe();
    const body = api.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body['phone']).toBeUndefined();
    expect(body['dateOfBirth']).toBeUndefined();
  });
});

describe('CustomersApi.update — sparse body (toBackendUpdate)', () => {
  it('forwards ONLY the included fields + rowVersion (omitted fields preserve stored PII)', () => {
    const api = fullApiMock(detailResponse);
    const payload: UpdateCustomerRequest = {
      rowVersion: 7,
      name: 'New Name',
      kycStatus: 'VERIFIED',
      isActive: true,
    };
    new CustomersApi(api).update('1', payload).subscribe();
    expect(api.put).toHaveBeenCalledWith('/customers/1', {
      rowVersion: 7,
      fullName: 'New Name',
      kycStatus: 'VERIFIED',
      status: 'ACTIVE',
    });
  });

  it('maps isActive:false to status INACTIVE and a blank phone/dob to undefined', () => {
    const api = fullApiMock(detailResponse);
    const payload: UpdateCustomerRequest = {
      rowVersion: 3,
      email: 'e@example.com',
      phone: '   ',
      dateOfBirth: '',
      address: { country: 'TR', city: 'Ankara', postalCode: '', line1: '' },
      isActive: false,
    };
    new CustomersApi(api).update('1', payload).subscribe();
    expect(api.put).toHaveBeenCalledWith('/customers/1', {
      rowVersion: 3,
      email: 'e@example.com',
      phone: undefined,
      dateOfBirth: undefined,
      address: { country: 'TR', city: 'Ankara', postalCode: undefined, line1: undefined },
      status: 'INACTIVE',
    });
  });

  it('keeps a non-blank phone (trimmed) on update (the truthy-phone branch)', () => {
    const api = fullApiMock(detailResponse);
    new CustomersApi(api).update('1', { rowVersion: 2, phone: '  +90 532  ' }).subscribe();
    expect(api.put).toHaveBeenCalledWith('/customers/1', { rowVersion: 2, phone: '+90 532' });
  });

  it('keeps a non-empty dateOfBirth on update (the truthy-dob branch)', () => {
    const api = fullApiMock(detailResponse);
    new CustomersApi(api).update('1', { rowVersion: 4, dateOfBirth: '1991-05-05' }).subscribe();
    expect(api.put).toHaveBeenCalledWith('/customers/1', {
      rowVersion: 4,
      dateOfBirth: '1991-05-05',
    });
  });

  it('sends ONLY rowVersion when nothing else changed (every optional branch skipped)', () => {
    const api = fullApiMock(detailResponse);
    new CustomersApi(api).update('1', { rowVersion: 9 }).subscribe();
    expect(api.put).toHaveBeenCalledWith('/customers/1', { rowVersion: 9 });
  });
});

describe('CustomersApi.delete', () => {
  it('URL-encodes the id and issues a DELETE', () => {
    const api = fullApiMock(undefined);
    new CustomersApi(api).delete('a/b').subscribe();
    expect(api.delete).toHaveBeenCalledWith('/customers/a%2Fb');
  });
});

describe('customers.pii.* i18n parity', () => {
  it('defines the 5 reveal keys in BOTH en and tr bundles with identical paths', () => {
    const keys = ['reveal', 'mask', 'revealedNotice', 'revealAria', 'maskAria'] as const;
    const en = (enBundle as Record<string, any>).customers?.pii ?? {};
    const tr = (trBundle as Record<string, any>).customers?.pii ?? {};
    for (const k of keys) {
      expect(typeof en[k]).toBe('string');
      expect(en[k].length).toBeGreaterThan(0);
      expect(typeof tr[k]).toBe('string');
      expect(tr[k].length).toBeGreaterThan(0);
    }
    // Exact key-path parity: the two bundles expose the same reveal keys, no orphan on either side.
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
    expect(Object.keys(tr).sort()).toEqual([...keys].sort());
  });
});
