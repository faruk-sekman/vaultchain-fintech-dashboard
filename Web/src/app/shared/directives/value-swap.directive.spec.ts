/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ValueSwapDirective } from '@shared/directives/value-swap.directive';

@Component({
  standalone: true,
  imports: [ValueSwapDirective],
  template: `<span [appValueSwap]="value()">{{ value() }}</span>`,
})
class HostComponent {
  // Signal so the zoneless test runner marks the view dirty on updates.
  readonly value = signal<string | number | null>(100);
}

describe('ValueSwapDirective', () => {
  let fixture: ComponentFixture<HostComponent>;

  const valueEl = (): HTMLElement =>
    fixture.debugElement.query(By.directive(ValueSwapDirective)).nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('does not animate the first render (skeleton/page entrance owns first paint)', () => {
    expect(valueEl().classList.contains('value-updating')).toBe(false);
  });

  it('replays the one-shot swap class when the bound value changes', () => {
    fixture.componentInstance.value.set(250);
    fixture.detectChanges();

    expect(valueEl().classList.contains('value-updating')).toBe(true);
  });

  it('stays inert when change detection runs with the same value', () => {
    fixture.componentInstance.value.set(100);
    fixture.detectChanges();

    expect(valueEl().classList.contains('value-updating')).toBe(false);
  });

  it('animates again on subsequent updates (class re-applied after reflow)', () => {
    fixture.componentInstance.value.set(250);
    fixture.detectChanges();
    fixture.componentInstance.value.set(300);
    fixture.detectChanges();

    expect(valueEl().classList.contains('value-updating')).toBe(true);
  });
});
