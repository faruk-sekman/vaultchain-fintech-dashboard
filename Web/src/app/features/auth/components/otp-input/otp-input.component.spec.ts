/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OtpInputComponent } from './otp-input.component';

function makeInputEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  return { target: input } as unknown as Event;
}

function makePasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: { getData: () => text },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

describe('OtpInputComponent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writeValue keeps only digits and caps at 6', () => {
    const c = new OtpInputComponent();
    c.writeValue('12ab34567');
    expect(c.value()).toBe('123456');
    expect(c.complete()).toBe(true);
  });

  it('is incomplete until all six are present', () => {
    const c = new OtpInputComponent();
    c.writeValue('123');
    expect(c.complete()).toBe(false);
  });

  it('onInput stores the last typed digit and emits the joined value', () => {
    const c = new OtpInputComponent();
    const changes: string[] = [];
    c.registerOnChange(v => changes.push(v));
    c.onInput(0, makeInputEvent('9'));
    expect(c.value()).toBe('9');
    expect(changes.at(-1)).toBe('9');
  });

  it('onPaste distributes six digits and emits', () => {
    const c = new OtpInputComponent();
    const changes: string[] = [];
    c.registerOnChange(v => changes.push(v));
    const ev = makePasteEvent('  9 8 7 6 5 4 ');
    c.onPaste(ev);
    expect(c.value()).toBe('987654');
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(changes.at(-1)).toBe('987654');
  });

  it('Backspace on a filled box clears that box', () => {
    const c = new OtpInputComponent();
    c.writeValue('123456');
    const ev = { key: 'Backspace', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    c.onKeydown(2, ev);
    expect(c.value()).toBe('12456');
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('pulseError toggles the error flag and clears it after the shake', () => {
    const c = new OtpInputComponent();
    c.pulseError();
    vi.advanceTimersByTime(1);
    expect(c.errored()).toBe(true);
    vi.advanceTimersByTime(440);
    expect(c.errored()).toBe(false);
  });

  it('setDisabledState reflects on the disabled signal', () => {
    const c = new OtpInputComponent();
    c.setDisabledState(true);
    expect(c.disabled()).toBe(true);
  });

  it('registerOnTouched is invoked whenever a digit changes', () => {
    const c = new OtpInputComponent();
    const touched = vi.fn();
    c.registerOnTouched(touched);
    c.onInput(0, makeInputEvent('3'));
    expect(touched).toHaveBeenCalled();
  });

  it('writeValue pads with empties when fewer than six digits are supplied', () => {
    const c = new OtpInputComponent();
    c.writeValue('12');
    expect(c.digits()).toEqual(['1', '2', '', '', '', '']);
  });

  it('writeValue with null clears every box', () => {
    const c = new OtpInputComponent();
    c.writeValue('123');
    c.writeValue(null);
    expect(c.value()).toBe('');
  });

  it('onInput strips non-numeric characters before storing the digit', () => {
    const c = new OtpInputComponent();
    c.onInput(0, makeInputEvent('a'));
    expect(c.value()).toBe('');
    c.onInput(0, makeInputEvent('7x'));
    expect(c.digits()[0]).toBe('7');
  });

  it('Backspace on the first empty box does not navigate below index 0', () => {
    const c = new OtpInputComponent();
    const ev = { key: 'Backspace', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    c.onKeydown(0, ev);
    expect(c.value()).toBe('');
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('ArrowLeft at index 0 and ArrowRight at the last index are no-ops (no preventDefault)', () => {
    const c = new OtpInputComponent();
    const left = { key: 'ArrowLeft', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    c.onKeydown(0, left);
    expect(left.preventDefault).not.toHaveBeenCalled();
    const right = { key: 'ArrowRight', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    c.onKeydown(c.length - 1, right);
    expect(right.preventDefault).not.toHaveBeenCalled();
  });

  it('a non-navigation key is ignored', () => {
    const c = new OtpInputComponent();
    const ev = { key: 'a', preventDefault: vi.fn() } as unknown as KeyboardEvent;
    c.onKeydown(0, ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('onPaste with no digits is a no-op and never preventDefaults', () => {
    const c = new OtpInputComponent();
    const changes: string[] = [];
    c.registerOnChange(v => changes.push(v));
    const ev = makePasteEvent('abc-def');
    c.onPaste(ev);
    expect(c.value()).toBe('');
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it('onPaste of a partial code fills the leading boxes and leaves the rest empty', () => {
    const c = new OtpInputComponent();
    c.onPaste(makePasteEvent('12'));
    expect(c.digits()).toEqual(['1', '2', '', '', '', '']);
  });

  it('pulseError on a complete code targets the last box (no empty cell to focus)', () => {
    const c = new OtpInputComponent();
    c.writeValue('123456');
    expect(() => c.pulseError()).not.toThrow();
    vi.advanceTimersByTime(1);
    expect(c.errored()).toBe(true);
  });

  it('a superseding pulseError cancels the prior shake timers', () => {
    const c = new OtpInputComponent();
    c.pulseError();
    c.pulseError(); // bumps errorSeq, so the first call's timers no-op
    vi.advanceTimersByTime(1);
    expect(c.errored()).toBe(true);
    vi.advanceTimersByTime(440);
    expect(c.errored()).toBe(false);
  });
});

/**
 * Rendered harness: a real `TestBed.createComponent` populates the `@ViewChildren('box')`
 * QueryList, so the focus-management branches (`focusBox`, auto-advance, ←/→ nav, the
 * Backspace-on-empty step-back, and `onFocus` select) actually execute against live inputs.
 */
describe('OtpInputComponent (rendered)', () => {
  let fixture: ComponentFixture<OtpInputComponent>;
  let component: OtpInputComponent;

  function boxAt(i: number): HTMLInputElement {
    return fixture.nativeElement.querySelectorAll('input')[i] as HTMLInputElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OtpInputComponent] });
    fixture = TestBed.createComponent(OtpInputComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('typing a digit auto-advances focus to the next box', () => {
    const first = boxAt(0);
    first.value = '5';
    first.dispatchEvent(new Event('input'));
    expect(component.digits()[0]).toBe('5');
    expect(document.activeElement).toBe(boxAt(1));
  });

  it('typing in the last box does not advance past the end', () => {
    const last = boxAt(component.length - 1);
    last.value = '9';
    last.dispatchEvent(new Event('input'));
    expect(component.digits()[component.length - 1]).toBe('9');
    // No box beyond the last to receive focus; nothing throws and the value sticks.
    expect(component.value().endsWith('9')).toBe(true);
  });

  it('ArrowRight then ArrowLeft move focus between boxes', () => {
    boxAt(0).focus();
    boxAt(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(document.activeElement).toBe(boxAt(1));
    boxAt(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(document.activeElement).toBe(boxAt(0));
  });

  it('Backspace on an empty box steps back and clears the previous box', () => {
    component.writeValue('12');
    fixture.detectChanges();
    boxAt(2).focus();
    boxAt(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    // index 2 was empty → focus steps to index 1 and clears it.
    expect(document.activeElement).toBe(boxAt(1));
    expect(component.digits()[1]).toBe('');
  });

  it('focusing a box selects its contents (onFocus)', () => {
    const first = boxAt(0);
    first.value = '4';
    const spy = vi.spyOn(first, 'select');
    first.dispatchEvent(new Event('focus'));
    expect(spy).toHaveBeenCalled();
  });

  it('pulseError focuses the first empty box', () => {
    component.writeValue('1');
    fixture.detectChanges();
    component.pulseError();
    // The first empty box is index 1.
    expect(document.activeElement).toBe(boxAt(1));
  });
});
