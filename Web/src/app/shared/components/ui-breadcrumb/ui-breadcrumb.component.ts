/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';

/**
 * A single breadcrumb entry. Provide `labelKey` (i18n) or `label` (already-translated).
 * `link` makes the crumb a router link; the last crumb is always rendered as the current
 * page (no link) regardless of its `link`.
 */
export interface UiBreadcrumbItem {
  /** ngx-translate key for the crumb label. */
  labelKey?: string;
  /** Pre-translated label; used when `labelKey` is absent. */
  label?: string;
  /** RouterLink target (path string or commands array). Omitted → plain text crumb. */
  link?: string | unknown[] | null;
}

/** A rendered crumb after collapsing: either a real item or the "…" ellipsis placeholder. */
interface RenderedCrumb {
  item: UiBreadcrumbItem | null;
  ellipsis: boolean;
  /** True for the final crumb (current page — no link, aria-current="page"). */
  current: boolean;
}

/** Max crumbs shown before the middle collapses to a single "…" (design §5.17). */
const COLLAPSE_THRESHOLD = 4;

/**
 * Breadcrumb (design-system-ui-kit.md §5.17). A `nav[aria-label]` wrapping an `ol`; crumbs are
 * separated by `ri-arrow-right-s-line`. Every crumb except the last is a link (when it has a
 * `link`); the last crumb is the current page — no link, `aria-current="page"`. When more than
 * four crumbs are supplied the middle ones collapse to a single non-interactive `…`, always
 * keeping the first crumb and the last two.
 *
 * Standalone + OnPush, tokens-only. Labels are localised via `labelKey` (or pre-translated
 * `label`); the separators are decorative (`aria-hidden`).
 */
@Component({
  selector: 'app-ui-breadcrumb',
  standalone: true,
  imports: [CommonModule, RouterLink, TranslateModule],
  templateUrl: './ui-breadcrumb.component.html',
  styleUrl: './ui-breadcrumb.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiBreadcrumbComponent {
  /** Crumbs from root → current. The last entry is treated as the current page. */
  readonly items = input<ReadonlyArray<UiBreadcrumbItem>>([]);
  /** Accessible name for the nav landmark (i18n key). Defaults to `common.breadcrumb`. */
  readonly ariaLabelKey = input('common.breadcrumb');
  readonly id = input<string | null>(null);

  /**
   * The crumbs actually rendered, with the middle collapsed to an ellipsis when there are more
   * than four. Always preserves the first crumb and the final two (… inserted between).
   */
  get rendered(): RenderedCrumb[] {
    const items = this.items();
    const lastIndex = items.length - 1;

    if (items.length <= COLLAPSE_THRESHOLD) {
      return items.map((item, i) => ({ item, ellipsis: false, current: i === lastIndex }));
    }

    return [
      { item: items[0], ellipsis: false, current: false },
      { item: null, ellipsis: true, current: false },
      { item: items[lastIndex - 1], ellipsis: false, current: false },
      { item: items[lastIndex], ellipsis: false, current: true },
    ];
  }

  trackByIndex(index: number): number {
    return index;
  }

  /** A crumb links only when it is not the current page and carries a non-empty `link`. */
  hasLink(crumb: RenderedCrumb): boolean {
    if (crumb.current || crumb.ellipsis || !crumb.item) return false;
    const link = crumb.item.link;
    if (link === null || link === undefined) return false;
    if (Array.isArray(link)) return link.length > 0;
    return String(link).length > 0;
  }
}
