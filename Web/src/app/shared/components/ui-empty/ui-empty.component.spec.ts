/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`;
 * the `output()` is observed via its `subscribe`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiEmptyComponent } from '@shared/components/ui-empty/ui-empty.component';

describe('UiEmptyComponent', () => {
  let component: UiEmptyComponent;
  let ref: ComponentRef<UiEmptyComponent>;

  const set = (inputs: Record<string, unknown>): UiEmptyComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiEmptyComponent] });
    const fixture = TestBed.createComponent(UiEmptyComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('has a sensible default illustration glyph and null copy', () => {
    expect(component.icon()).toBe('ri-inbox-line');
    expect(component.title()).toBeNull();
    expect(component.message()).toBeNull();
    expect(component.actionLabel()).toBeNull();
  });

  it('carries title, message, custom icon and action inputs', () => {
    const empty = set({
      icon: 'ri-search-line',
      title: 'No customers yet',
      message: 'Add your first customer to get started.',
      actionLabel: 'Add customer',
      actionIcon: 'ri-add-line',
    });
    expect(empty.icon()).toBe('ri-search-line');
    expect(empty.title()).toBe('No customers yet');
    expect(empty.message()).toBe('Add your first customer to get started.');
    expect(empty.actionLabel()).toBe('Add customer');
    expect(empty.actionIcon()).toBe('ri-add-line');
  });

  it('emits actionClick when the built-in action fires', () => {
    const emit = vi.fn();
    component.actionClick.subscribe(emit);
    component.onAction();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
