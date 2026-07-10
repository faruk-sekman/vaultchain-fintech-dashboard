/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ContentChild,
  EventEmitter,
  Input,
  Output,
  TemplateRef,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';
import { LocaleFormatService } from '@core/services/locale-format.service';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiBadgeComponent, UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { UiPaginationComponent } from '@shared/components/ui-pagination/ui-pagination.component';
import {
  CellTemplateContext,
  ColumnDef,
  PageEvent,
  TableDensity,
} from '@shared/components/ui-table/ui-table.types';

@Component({
  selector: 'app-ui-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    TranslateModule,
    UiButtonComponent,
    UiBadgeComponent,
    UiPaginationComponent,
  ],
  templateUrl: './ui-table.component.html',
  styleUrls: ['./ui-table.component.scss'],
})
export class UiTableComponent<T extends Record<string, any>> {
  @Input({ required: true }) columns!: ColumnDef<T>[];
  @Input({ required: true }) data!: T[];

  @Input() loading = false;
  @Input() page = 1;
  @Input() pageSize = 10;
  @Input() total = 0;
  @Input() showFilters = false;
  @Input() pageWindow = 5;

  /** Row density (§5.15): `comfortable` (default, ~56px) or `compact` (~44px). Tokens-only. */
  @Input() density: TableDensity = 'comfortable';

  /** When false, the table renders no actions column and emits no `rowAction`. Default keeps existing behavior. */
  @Input() showRowActions = true;

  @Input() rowActionLabelKey = 'common.details';

  /** Accessible name (i18n key) for the horizontally-scrollable region, so keyboard users who Tab
   * into it to scroll a wide table hear what it is. Overridable per table for a more specific name. */
  @Input() scrollLabelKey = 'common.dataTable';

  /** When true (and not loading), the body renders a distinct retryable error row instead of the empty row. */
  @Input() error = false;
  @Input() errorKey = 'common.loadError';
  @Input() retryLabelKey = 'common.retry';

  @Output() pageChange = new EventEmitter<PageEvent>();
  @Output() rowAction = new EventEmitter<T>();
  @Output() retry = new EventEmitter<void>();

  @ContentChild('rowActions', { read: TemplateRef }) rowActionsTemplate?: TemplateRef<unknown>;

  /** App default display currency for a currency column whose row carries no currency (op-uitable-try). */
  private readonly defaultDisplayCurrency = 'TRY';

  constructor(
    private readonly i18n: TranslateService,
    /**
     * B2: the central locale service replaces the old per-table `Intl.NumberFormat(undefined,…)`
     * (which followed the BROWSER locale, not the UI language) and the loose `'tr'/'en'` date
     * tags — all cells now follow the ACTIVE UI language, live on switch.
     */
    private readonly fmt: LocaleFormatService,
  ) {}

  displayCell(col: ColumnDef<T>, row: T): string {
    const raw = row[col.key as string];
    if (col.formatter) return col.formatter(raw, row);
    if (raw === undefined || raw === null) return '-';

    if (col.type === 'currency' && typeof raw === 'number') {
      const currency = (row as { currency?: string }).currency ?? this.defaultDisplayCurrency;
      return this.fmt.currency(raw, currency);
    }
    if (col.type === 'date') {
      const d = new Date(String(raw));
      if (isNaN(d.getTime())) return String(raw);
      return this.fmt.date(d, 'short');
    }
    return String(raw);
  }

  badgeColor(col: ColumnDef<T>, row: T): UiBadgeColor {
    const value = row[col.key as string];
    let resolved: UiBadgeColor | undefined;
    if (typeof col.badgeColor === 'function') {
      resolved = col.badgeColor(value, row);
    } else {
      resolved = col.badgeColor;
    }
    return resolved ?? 'gray';
  }

  badgeIcon(col: ColumnDef<T>, row: T): string | null {
    const value = row[col.key as string];
    let resolved: string | null | undefined;
    if (typeof col.badgeIcon === 'function') {
      resolved = col.badgeIcon(value, row);
    } else {
      resolved = col.badgeIcon;
    }
    return resolved ?? null;
  }

  toggleOn(col: ColumnDef<T>, row: T): boolean {
    return Boolean(row[col.key as string]);
  }

  /** Builds the context object passed to a column's custom `cellTemplate`. */
  cellContext(col: ColumnDef<T>, row: T): CellTemplateContext<T> {
    const value = row[col.key];
    return { $implicit: value, value, row, column: col };
  }

  /** Stable identity for @for: prefer the row's `id`, fall back to index. */
  trackRow(row: T, index: number): string | number {
    const id = row['id'];
    return typeof id === 'string' || typeof id === 'number' ? id : index;
  }

  onPageChange(e: PageEvent) {
    this.pageChange.emit(e);
  }
}
