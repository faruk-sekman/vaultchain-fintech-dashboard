/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { SimpleChange } from '@angular/core';
import { CustomerRiskHistoryComponent } from './customer-risk-history.component';
import { Web3Service } from '@core/services/web3.service';
import { AppErrorService } from '@core/services/app-error.service';
import { TranslateService } from '@ngx-translate/core';

function make(listImpl?: any) {
  const web3 = {
    listRiskAssessments:
      listImpl ??
      vi.fn(() =>
        of({
          data: [
            { id: 'r1', decision: 'ALLOW', isSimulated: true, providerName: 'P', createdAt: '' },
          ],
          page: 1,
          pageSize: 5,
          total: 1,
        }),
      ),
  } as any;
  const appError = { handleError: vi.fn() } as any;
  const i18n = { instant: (k: string) => k, currentLang: 'en' } as any;

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Web3Service, useValue: web3 },
      { provide: AppErrorService, useValue: appError },
      { provide: TranslateService, useValue: i18n },
    ],
  });
  const component = TestBed.runInInjectionContext(() => new CustomerRiskHistoryComponent());
  return { component, web3, appError, i18n };
}

function changeCustomerId(component: CustomerRiskHistoryComponent, id: string) {
  component.customerId = id;
  component.ngOnChanges({ customerId: new SimpleChange(undefined, id, true) });
}

describe('CustomerRiskHistoryComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads page 1 on a customerId change and stores the result', () => {
    const { component, web3 } = make();
    changeCustomerId(component, 'c1');
    expect(web3.listRiskAssessments).toHaveBeenCalledWith('c1', { page: 1, pageSize: 5 });
    expect(component.riskPage()).toBe(1);
    expect(component.riskHistory().length).toBe(1);
    expect(component.riskTotal()).toBe(1);
    expect(component.loadingRiskHistory()).toBe(false);
  });

  it('does not load when ngOnChanges fires without a customerId', () => {
    const { component, web3 } = make();
    component.ngOnChanges({});
    expect(web3.listRiskAssessments).not.toHaveBeenCalled();
  });

  it('dispatches the requested page on a pager change', () => {
    const { component, web3 } = make();
    component.customerId = 'c2';
    component.onRiskPageChange({ page: 4, pageSize: 5 });
    expect(component.riskPage()).toBe(4);
    expect(web3.listRiskAssessments).toHaveBeenCalledWith('c2', { page: 4, pageSize: 5 });
  });

  it('routes a load error through AppErrorService and clears the loading flag', () => {
    const { component, appError } = make(vi.fn(() => throwError(() => new Error('boom'))));
    changeCustomerId(component, 'c3');
    expect(appError.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'loadRiskHistory' }),
    );
    expect(component.loadingRiskHistory()).toBe(false);
  });

  it('maps a risk decision to a semantic badge tone (REVIEW=info-blue, not warning-yellow)', () => {
    const { component } = make();
    expect(component.riskDecisionColor('BLOCK' as any)).toBe('red');
    expect(component.riskDecisionColor('REVIEW' as any)).toBe('blue');
    expect(component.riskDecisionColor('ALLOW' as any)).toBe('green');
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
});
