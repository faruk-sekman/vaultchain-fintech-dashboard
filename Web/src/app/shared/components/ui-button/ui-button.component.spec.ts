/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';

describe('UiButtonComponent', () => {
  let component: UiButtonComponent;
  let ref: ComponentRef<UiButtonComponent>;

  const set = (inputs: Record<string, unknown>): UiButtonComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiButtonComponent] });
    const fixture = TestBed.createComponent(UiButtonComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  describe('ariaLabel', () => {
    it('defaults ariaLabel to null so labeled buttons stay opt-in', () => {
      expect(component.ariaLabel()).toBeNull();
    });

    it('accepts an accessible name for icon-only buttons', () => {
      expect(set({ ariaLabel: 'Delete customer' }).ariaLabel()).toBe('Delete customer');
    });

    it('accepts the additive v2 pill variant without changing the default', () => {
      expect(component.variant()).toBe('primary'); // default untouched
      expect(set({ variant: 'pill' }).variant()).toBe('pill');
    });

    it('accepts the additive v2 lg size without changing the default', () => {
      expect(component.size()).toBe('md'); // default untouched
      expect(set({ size: 'lg' }).size()).toBe('lg');
    });

    it('keeps compact layout options opt-in', () => {
      expect(component.iconOnly()).toBe(false);
      expect(component.fullWidth()).toBe(false);
      expect(component.isFullWidth).toBe(false);

      set({ iconOnly: true, fullWidth: true });
      expect(component.iconOnly()).toBe(true);
      expect(component.isFullWidth).toBe(true);
    });
  });

  describe('inline loading (motion-system §3)', () => {
    // The template binds [disabled]="disabled || loading", aria-busy and the spinner from this
    // single input; the binding wiring is covered by `ng build`'s strictTemplates pass and QA.
    it('stays a plain enabled button by default (loading opt-in)', () => {
      expect(component.loading()).toBe(false);
    });

    it('accepts the additive loading state without changing other defaults', () => {
      set({ loading: true });
      expect(component.loading()).toBe(true);
      expect(component.disabled()).toBe(false); // disabling is composed in the template
      expect(component.variant()).toBe('primary');
    });
  });
});
