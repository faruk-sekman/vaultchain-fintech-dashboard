/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { SimpleChange } from '@angular/core';
import { CustomerKycHistoryComponent } from './customer-kyc-history.component';
import { KycVerificationsStore } from '@features/customers/state';
import { TranslateService } from '@ngx-translate/core';

function make(i18nInstant: (k: string) => string = (k: string) => k) {
  const kycVerificationsStore = {
    data$: of([]),
    total$: of(0),
    loading$: of(false),
    load: vi.fn(),
  } as any;
  const i18n = { instant: i18nInstant, currentLang: 'en' } as any;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: KycVerificationsStore, useValue: kycVerificationsStore },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new CustomerKycHistoryComponent());
  return { component, kycVerificationsStore, i18n };
}

function changeCustomerId(component: CustomerKycHistoryComponent, id: string) {
  component.customerId = id;
  component.ngOnChanges({ customerId: new SimpleChange(undefined, id, true) });
}

describe('CustomerKycHistoryComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads page 1 on a customerId change', () => {
    const { component, kycVerificationsStore } = make();
    changeCustomerId(component, 'c1');
    expect(component.kycPage()).toBe(1);
    expect(kycVerificationsStore.load).toHaveBeenCalledWith('c1', { page: 1, pageSize: 5 });
  });

  it('does not load when ngOnChanges fires without a customerId', () => {
    const { component, kycVerificationsStore } = make();
    component.ngOnChanges({});
    expect(kycVerificationsStore.load).not.toHaveBeenCalled();
  });

  it('dispatches the requested page on a pager change', () => {
    const { component, kycVerificationsStore } = make();
    component.customerId = 'c2';
    component.onKycPageChange({ page: 3, pageSize: 5 });
    expect(component.kycPage()).toBe(3);
    expect(kycVerificationsStore.load).toHaveBeenCalledWith('c2', { page: 3, pageSize: 5 });
  });

  it('kycMethodLabel translates a known method, prettifies unknown, and dashes empty', () => {
    const { component } = make();
    // The echo-i18n returns the key (no real translation) → falls back to Title-Case prettify.
    expect(component.kycMethodLabel('manual_review')).toBe('Manual Review');
    expect(component.kycMethodLabel('E_KYC')).toBe('E Kyc');
    expect(component.kycMethodLabel(null)).toBe('—');

    // With a real translation present, the i18n value wins (raw token never leaks).
    const real = make(k => (k === 'customerDetail.kycMethod.manual' ? 'Manuel' : k));
    expect(real.component.kycMethodLabel('manual')).toBe('Manuel');
  });

  it('formatShortDate renders a localized date or a dash for empty/invalid input', () => {
    const { component } = make();
    expect(component.formatShortDate(null)).toBe('—');
    expect(component.formatShortDate('not-a-date')).toBe('—');
    expect(component.formatShortDate('2026-06-20T00:00:00Z')).not.toBe('—');
  });

  it('formatShortDate follows the Turkish locale when the active language is tr', () => {
    const { component, i18n } = make();
    i18n.currentLang = 'tr';
    expect(component.formatShortDate('2026-06-20T00:00:00Z')).not.toBe('—');
  });

  it('exposes the store streams for the template', () => {
    const { component } = make();
    expect(component.kycData$).toBeTruthy();
    expect(component.kycTotal$).toBeTruthy();
    expect(component.loadingKyc$).toBeTruthy();
    expect(component.kycPageSize).toBe(5);
  });
});
