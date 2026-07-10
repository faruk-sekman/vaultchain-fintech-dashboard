/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import type { TemplateRef } from '@angular/core';
import type { UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';

export type ColumnType = 'text' | 'currency' | 'date' | 'badge' | 'toggle';

/** Row density (§5.15): `comfortable` ~56px rows (default), `compact` ~44px. */
export type TableDensity = 'comfortable' | 'compact';

/**
 * Context handed to a column's custom {@link ColumnDef.cellTemplate}.
 * `$implicit` is the cell's raw value so `let-value` works; `row` and `column`
 * give the template the full record and its own definition.
 */
export interface CellTemplateContext<T> {
  $implicit: T[keyof T];
  value: T[keyof T];
  row: T;
  column: ColumnDef<T>;
}

export interface ColumnDef<T> {
  key: keyof T;
  headerKey: string;
  type?: ColumnType;
  formatter?: (value: any, row: T) => string;
  widthClass?: string;
  badgeColor?: UiBadgeColor | ((value: any, row: T) => UiBadgeColor);
  badgeIcon?: string | null | ((value: any, row: T) => string | null);
  /**
   * Optional custom cell renderer for THIS column. When supplied, it fully
   * replaces the default value/badge/toggle output for the column; the template
   * receives a {@link CellTemplateContext}. When omitted, rendering is unchanged.
   */
  cellTemplate?: TemplateRef<CellTemplateContext<T>>;
}

export interface PageEvent {
  page: number; // 1-based
  pageSize: number;
}
