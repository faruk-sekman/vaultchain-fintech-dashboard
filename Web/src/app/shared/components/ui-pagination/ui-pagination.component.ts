/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { PageEvent } from '@shared/components/ui-table/ui-table.types';

@Component({
  selector: 'app-ui-pagination',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './ui-pagination.component.html',
  styleUrl: './ui-pagination.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiPaginationComponent {
  readonly page = input(1);
  readonly pageSize = input(10);
  readonly total = input(0);
  readonly pageWindow = input(5);

  readonly pageChange = output<PageEvent>();

  get totalPages(): number {
    return Math.max(1, Math.ceil((this.total() || 0) / (this.pageSize() || 1)));
  }

  get pages(): number[] {
    const total = this.totalPages;
    const page = this.page();
    const maxVisible = Math.min(5, Math.max(1, this.pageWindow() || 1));

    if (total <= maxVisible) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }

    if (maxVisible === 1) {
      return [page];
    }

    if (maxVisible === 2) {
      return [1, total];
    }

    const middleCount = maxVisible - 2;
    let start = page - Math.floor(middleCount / 2);
    let end = start + middleCount - 1;

    if (start < 2) {
      start = 2;
      end = start + middleCount - 1;
    }

    if (end > total - 1) {
      end = total - 1;
      start = end - middleCount + 1;
    }

    const middle: number[] = [];
    for (let i = start; i <= end; i++) middle.push(i);

    return [1, ...middle, total];
  }

  prev() {
    const page = this.page();
    if (page <= 1) return;
    this.pageChange.emit({ page: page - 1, pageSize: this.pageSize() });
  }

  next() {
    const page = this.page();
    if (page >= this.totalPages) return;
    this.pageChange.emit({ page: page + 1, pageSize: this.pageSize() });
  }

  goTo(page: number) {
    if (page === this.page() || page < 1 || page > this.totalPages) return;
    this.pageChange.emit({ page, pageSize: this.pageSize() });
  }
}
