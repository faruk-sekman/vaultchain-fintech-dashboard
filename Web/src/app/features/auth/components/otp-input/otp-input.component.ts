/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Six-box one-time-code input. A standalone ControlValueAccessor used by the reset
 * flow's verify step: type to auto-advance, Backspace to go back, ←/→ to navigate, paste to
 * distribute 6 digits. Digits only. Emits the joined string as the form-control value; a complete
 * row flashes a completion glow, and `pulseError()` shakes the row + focuses the first empty box.
 *
 * Standalone + OnPush. Styling reuses the `--ld-*` tokens inherited from the `.forgot` ancestor.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  QueryList,
  ViewChildren,
  forwardRef,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-otp-input',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => OtpInputComponent), multi: true },
  ],
  templateUrl: './otp-input.component.html',
  styleUrl: './otp-input.component.scss',
})
export class OtpInputComponent implements ControlValueAccessor {
  /** Number of digits (the design is a 6-box code). */
  readonly length = 6;
  readonly cells = Array.from({ length: this.length }, (_, i) => i);

  /** Accessible group + per-cell labels (translated strings passed by the parent). */
  @Input() groupLabel = 'Verification code';
  @Input() digitLabel = 'Digit';

  readonly digits = signal<string[]>(Array(this.length).fill(''));
  readonly disabled = signal(false);
  readonly errored = signal(false);

  @ViewChildren('box') private boxes!: QueryList<ElementRef<HTMLInputElement>>;

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};
  private errorSeq = 0;

  /** The current joined value (digits only). */
  value(): string {
    return this.digits().join('');
  }

  /** True once all six boxes hold a digit. */
  complete(): boolean {
    return this.value().length === this.length;
  }

  // ---- ControlValueAccessor ----
  writeValue(value: string | null): void {
    const chars = (value ?? '').replace(/\D/g, '').slice(0, this.length).split('');
    this.digits.set(Array.from({ length: this.length }, (_, i) => chars[i] ?? ''));
  }
  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // ---- interaction ----
  onInput(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const char = input.value.replace(/\D/g, '').slice(-1);
    this.setDigit(index, char);
    input.value = char;
    if (char && index < this.length - 1) this.focusBox(index + 1);
  }

  onKeydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace') {
      if (this.digits()[index]) {
        this.setDigit(index, '');
      } else if (index > 0) {
        this.focusBox(index - 1);
        this.setDigit(index - 1, '');
      }
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      this.focusBox(index - 1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight' && index < this.length - 1) {
      this.focusBox(index + 1);
      event.preventDefault();
    }
  }

  onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    const chars = text.replace(/\D/g, '').slice(0, this.length).split('');
    if (!chars.length) return;
    event.preventDefault();
    this.digits.set(Array.from({ length: this.length }, (_, i) => chars[i] ?? ''));
    this.emit();
    this.focusBox(Math.min(chars.length, this.length - 1));
  }

  onFocus(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  /** Shake the row and focus the first empty box — called by the parent on an incomplete submit. */
  pulseError(): void {
    const seq = ++this.errorSeq;
    this.errored.set(false);
    setTimeout(() => {
      if (this.errorSeq === seq) this.errored.set(true);
    });
    setTimeout(() => {
      if (this.errorSeq === seq) this.errored.set(false);
    }, 440);
    const firstEmpty = this.digits().findIndex(d => !d);
    this.focusBox(firstEmpty === -1 ? this.length - 1 : firstEmpty);
  }

  private setDigit(index: number, char: string): void {
    const next = [...this.digits()];
    next[index] = char;
    this.digits.set(next);
    this.emit();
  }

  private emit(): void {
    this.onChange(this.value());
    this.onTouched();
  }

  private focusBox(index: number): void {
    const el = this.boxes?.get(index)?.nativeElement;
    el?.focus();
    el?.select();
  }
}
