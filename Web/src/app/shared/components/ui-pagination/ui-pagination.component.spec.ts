/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Pins the page-window algorithm (the one place with real logic — first/last anchors with a sliding
 * middle) and the boundary-respecting prev/next/goTo emitters. Signal inputs are set through
 * `ComponentRef.setInput()` on a real `TestBed.createComponent()`; the template's translate pipe is
 * satisfied by `TranslateModule.forRoot()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { UiPaginationComponent } from './ui-pagination.component';
import type { PageEvent } from '@shared/components/ui-table/ui-table.types';

function make(inputs: Partial<Record<keyof UiPaginationComponent, unknown>> = {}): {
  fixture: ComponentFixture<UiPaginationComponent>;
  component: UiPaginationComponent;
} {
  const fixture = TestBed.createComponent(UiPaginationComponent);
  for (const [key, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(key, value);
  }
  return { fixture, component: fixture.componentInstance };
}

const capture = (c: UiPaginationComponent): PageEvent[] => {
  const events: PageEvent[] = [];
  c.pageChange.subscribe(e => events.push(e));
  return events;
};

describe('UiPaginationComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiPaginationComponent, TranslateModule.forRoot()],
    });
  });

  describe('totalPages', () => {
    it('is at least 1 even with no rows', () => {
      expect(make({ total: 0, pageSize: 10 }).component.totalPages).toBe(1);
    });

    it('ceils partial pages', () => {
      expect(make({ total: 25, pageSize: 10 }).component.totalPages).toBe(3);
      expect(make({ total: 100, pageSize: 10 }).component.totalPages).toBe(10);
    });

    it('guards against a zero pageSize', () => {
      expect(make({ total: 10, pageSize: 0 }).component.totalPages).toBe(10);
    });
  });

  describe('pages (window)', () => {
    it('lists every page when they fit the window', () => {
      expect(make({ total: 30, pageSize: 10, pageWindow: 5 }).component.pages).toEqual([1, 2, 3]);
    });

    it('anchors first + last with a sliding middle near the start', () => {
      expect(make({ total: 100, pageSize: 10, page: 1, pageWindow: 5 }).component.pages).toEqual([
        1, 2, 3, 4, 10,
      ]);
    });

    it('slides the middle around the current page', () => {
      expect(make({ total: 100, pageSize: 10, page: 5, pageWindow: 5 }).component.pages).toEqual([
        1, 4, 5, 6, 10,
      ]);
    });

    it('clamps the middle at the end', () => {
      expect(make({ total: 100, pageSize: 10, page: 10, pageWindow: 5 }).component.pages).toEqual([
        1, 7, 8, 9, 10,
      ]);
    });

    it('degenerates to first+last for a window of 2, and a single page for 1', () => {
      expect(make({ total: 100, pageSize: 10, pageWindow: 2 }).component.pages).toEqual([1, 10]);
      expect(make({ total: 100, pageSize: 10, page: 4, pageWindow: 1 }).component.pages).toEqual([
        4,
      ]);
    });
  });

  describe('navigation', () => {
    it('prev does nothing on the first page, emits otherwise', () => {
      const first = make({ page: 1, pageSize: 10, total: 100 }).component;
      const a = capture(first);
      first.prev();
      expect(a).toEqual([]);

      const third = make({ page: 3, pageSize: 10, total: 100 }).component;
      const b = capture(third);
      third.prev();
      expect(b).toEqual([{ page: 2, pageSize: 10 }]);
    });

    it('next does nothing on the last page, emits otherwise', () => {
      const last = make({ page: 10, pageSize: 10, total: 100 }).component;
      const a = capture(last);
      last.next();
      expect(a).toEqual([]);

      const second = make({ page: 2, pageSize: 10, total: 100 }).component;
      const b = capture(second);
      second.next();
      expect(b).toEqual([{ page: 3, pageSize: 10 }]);
    });

    it('goTo ignores the current page and out-of-range targets', () => {
      const c = make({ page: 3, pageSize: 10, total: 100 }).component;
      const events = capture(c);
      c.goTo(3); // current
      c.goTo(0); // < 1
      c.goTo(99); // > totalPages
      expect(events).toEqual([]);

      c.goTo(5);
      expect(events).toEqual([{ page: 5, pageSize: 10 }]);
    });
  });
});
