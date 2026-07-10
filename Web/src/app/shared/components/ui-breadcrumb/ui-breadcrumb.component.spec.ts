/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Exercises the collapse logic and per-crumb link decision. Signal inputs are set through
 * `ComponentRef.setInput()` on a real `TestBed.createComponent()`; RouterLink + ngx-translate
 * are provided so the template compiles.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { UiBreadcrumbComponent, UiBreadcrumbItem } from './ui-breadcrumb.component';

describe('UiBreadcrumbComponent', () => {
  let component: UiBreadcrumbComponent;
  let ref: ComponentRef<UiBreadcrumbComponent>;

  const makeComponent = (items: UiBreadcrumbItem[]): UiBreadcrumbComponent => {
    ref.setInput('items', items);
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UiBreadcrumbComponent, TranslateModule.forRoot()],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(UiBreadcrumbComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('defaults to the generic breadcrumb aria-label key', () => {
    expect(component.ariaLabelKey()).toBe('common.breadcrumb');
  });

  it('renders all crumbs unchanged when there are four or fewer', () => {
    const rendered = makeComponent([
      { labelKey: 'customers.title', link: '/customers' },
      { label: 'Ada Lovelace' },
    ]).rendered;
    expect(rendered).toHaveLength(2);
    expect(rendered.some(c => c.ellipsis)).toBe(false);
  });

  it('marks only the last crumb as the current page', () => {
    const rendered = makeComponent([
      { labelKey: 'customers.title', link: '/customers' },
      { label: 'Ada Lovelace' },
    ]).rendered;
    expect(rendered[0].current).toBe(false);
    expect(rendered[1].current).toBe(true);
  });

  it('renders exactly four crumbs without collapsing at the threshold', () => {
    const rendered = makeComponent([
      { label: 'A', link: '/a' },
      { label: 'B', link: '/b' },
      { label: 'C', link: '/c' },
      { label: 'D' },
    ]).rendered;
    expect(rendered).toHaveLength(4);
    expect(rendered.some(c => c.ellipsis)).toBe(false);
    expect(rendered[3].current).toBe(true);
  });

  it('collapses the middle to a single ellipsis when there are more than four', () => {
    const rendered = makeComponent([
      { label: 'A', link: '/a' },
      { label: 'B', link: '/b' },
      { label: 'C', link: '/c' },
      { label: 'D', link: '/d' },
      { label: 'E' },
    ]).rendered;
    // first + ellipsis + second-to-last + last
    expect(rendered).toHaveLength(4);
    expect(rendered[0].item?.label).toBe('A');
    expect(rendered[1].ellipsis).toBe(true);
    expect(rendered[2].item?.label).toBe('D');
    expect(rendered[3].item?.label).toBe('E');
    expect(rendered[3].current).toBe(true);
  });

  it('links a non-current crumb that has a string link', () => {
    const c = makeComponent([{ label: 'Root', link: '/root' }, { label: 'Leaf' }]);
    const [root, leaf] = c.rendered;
    expect(c.hasLink(root)).toBe(true);
    // The current (last) crumb never links, even though it could.
    expect(c.hasLink(leaf)).toBe(false);
  });

  it('does not link a crumb without a link, an empty link, or the ellipsis', () => {
    const c = makeComponent([
      { label: 'NoLink' },
      { label: 'Empty', link: '' },
      { label: 'EmptyArr', link: [] },
      { label: 'Current' },
    ]);
    const rendered = c.rendered;
    expect(c.hasLink(rendered[0])).toBe(false); // missing link
    expect(c.hasLink(rendered[1])).toBe(false); // empty string
    expect(c.hasLink(rendered[2])).toBe(false); // empty array
    // Ellipsis crumb (force one via >4 items) never links.
    const collapsed = makeComponent([
      { label: 'A', link: '/a' },
      { label: 'B', link: '/b' },
      { label: 'C', link: '/c' },
      { label: 'D', link: '/d' },
      { label: 'E' },
    ]).rendered;
    expect(c.hasLink(collapsed[1])).toBe(false);
  });

  it('links a crumb that has a non-empty commands-array link', () => {
    const c = makeComponent([{ label: 'Root', link: ['/customers', '42'] }, { label: 'Leaf' }]);
    expect(c.hasLink(c.rendered[0])).toBe(true);
  });

  it('trackByIndex returns the index', () => {
    expect(component.trackByIndex(2)).toBe(2);
  });

  it('handles an empty items list without throwing', () => {
    expect(makeComponent([]).rendered).toEqual([]);
  });
});
