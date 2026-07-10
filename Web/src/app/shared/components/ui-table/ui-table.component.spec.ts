/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { UiTableComponent } from '@shared/components/ui-table/ui-table.component';

class TranslateMock {
  currentLang = 'en';
  instant(key: string) {
    return key;
  }
}

describe('UiTableComponent showRowActions', () => {
  it('defaults showRowActions to true so existing consumers are unchanged', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    expect(table.showRowActions).toBe(true);
  });

  it('can suppress the actions column via showRowActions=false', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    table.showRowActions = false;
    expect(table.showRowActions).toBe(false);
  });
});

describe('UiTableComponent error state', () => {
  it('defaults to no error with sensible error/retry i18n keys', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    expect(table.error).toBe(false);
    expect(table.errorKey).toBe('common.loadError');
    expect(table.retryLabelKey).toBe('common.retry');
  });

  it('emits retry when the retry action fires', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    const spy = vi.fn();
    table.retry.subscribe(spy);
    table.retry.emit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('can be put into the error state independently of the empty (data) state', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    table.data = [];
    table.error = true;
    // The template renders the error row when `error` is true regardless of data length;
    // here we assert the inputs that drive that branch coexist.
    expect(table.error).toBe(true);
    expect(table.data.length).toBe(0);
  });
});

describe('UiTableComponent density', () => {
  it('defaults density to comfortable so existing consumers are unchanged', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    expect(table.density).toBe('comfortable');
  });

  it('accepts compact density', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    table.density = 'compact';
    expect(table.density).toBe('compact');
  });
});

describe('UiTableComponent scrollable-region accessible name', () => {
  it('defaults the scroll-region label key to common.dataTable', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    // The template binds tabindex=0 + role=region + aria-label=(scrollLabelKey | translate) on
    // the overflow container so keyboard users can focus and scroll a wide table.
    expect(table.scrollLabelKey).toBe('common.dataTable');
  });

  it('accepts a per-table override for a more specific region name', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    table.scrollLabelKey = 'transactions.title';
    expect(table.scrollLabelKey).toBe('transactions.title');
  });
});

describe('UiTableComponent custom cell template', () => {
  it('builds a cell context exposing $implicit/value/row/column for the column key', () => {
    const table = new UiTableComponent<Record<string, unknown>>(new TranslateMock() as any);
    const row = { id: '1', name: 'Ada' };
    const col = { key: 'name', headerKey: 'customers.name' } as any;

    const ctx = table.cellContext(col, row);
    expect(ctx.$implicit).toBe('Ada');
    expect(ctx.value).toBe('Ada');
    expect(ctx.row).toBe(row);
    expect(ctx.column).toBe(col);
  });
});
