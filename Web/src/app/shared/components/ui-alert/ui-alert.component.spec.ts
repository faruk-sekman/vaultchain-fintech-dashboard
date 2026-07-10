/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Signal inputs are set through `ComponentRef.setInput()` on a real `TestBed.createComponent()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';

describe('UiAlertComponent', () => {
  let component: UiAlertComponent;
  let ref: ComponentRef<UiAlertComponent>;

  const set = (inputs: Record<string, unknown>): UiAlertComponent => {
    for (const [key, value] of Object.entries(inputs)) {
      ref.setInput(key, value);
    }
    return component;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [UiAlertComponent] });
    const fixture = TestBed.createComponent(UiAlertComponent);
    component = fixture.componentInstance;
    ref = fixture.componentRef;
  });

  it('defaults to info severity, polite status role and the info icon', () => {
    expect(component.type()).toBe('info');
    expect(component.dismissible()).toBe(false);
    expect(component.role).toBe('status');
    expect(component.iconClass).toBe('ri-information-line');
  });

  it('maps severity to the correct live-region role', () => {
    expect(set({ type: 'warning' }).role).toBe('alert');
    expect(set({ type: 'danger' }).role).toBe('alert');
    expect(set({ type: 'success' }).role).toBe('status');
    expect(set({ type: 'info' }).role).toBe('status');
  });

  it('resolves the default icon per severity', () => {
    expect(set({ type: 'success' }).iconClass).toBe('ri-checkbox-circle-line');
    expect(set({ type: 'warning' }).iconClass).toBe('ri-error-warning-line');
    expect(set({ type: 'danger' }).iconClass).toBe('ri-close-circle-line');
  });

  it('prefers an explicit icon override over the severity default', () => {
    expect(set({ type: 'danger', icon: 'ri-flag-line' }).iconClass).toBe('ri-flag-line');
  });

  it('emits dismissed when the close action fires', () => {
    const emit = vi.fn();
    component.dismissed.subscribe(emit);
    component.onDismiss();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('carries optional title/message/label inputs', () => {
    const alert = set({
      title: 'Payment failed',
      message: 'Card declined.',
      dismissible: true,
      dismissLabel: 'Dismiss',
      ariaLabel: 'KYC notice',
    });
    expect(alert.title()).toBe('Payment failed');
    expect(alert.message()).toBe('Card declined.');
    expect(alert.dismissLabel()).toBe('Dismiss');
    expect(alert.ariaLabel()).toBe('KYC notice');
  });
});
