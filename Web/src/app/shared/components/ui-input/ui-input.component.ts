/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-ui-input',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './ui-input.component.html',
  styleUrl: './ui-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiInputComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) control!: FormControl;
  @Input() id: string | null = null;
  /** `password` masks the value natively (no CSS hack) — used for re-auth fields. */
  @Input() type: 'text' | 'email' | 'password' | 'number' | 'date' | 'datetime-local' = 'text';
  @Input() lang: string | null = null;
  /** Optional native autocomplete hint (e.g. `current-password`); omitted when null. */
  @Input() autocomplete: string | null = null;
  @Input() inputClass: string | string[] | Set<string> | { [csClass: string]: any } | null = null;
  @Input() placeholder: string | null = null;
  @Input() mask: string | null = null;
  /**
   * Regex CHARACTER CLASS of characters to strip as the user types (e.g. `[^0-9+]` keeps only
   * digits and `+`). Complements `mask` for free-format fields like phone (A2/B7): invalid
   * characters never enter the model, so FE and BE validators see the same alphabet.
   */
  @Input() stripPattern: string | null = null;
  /** Native `maxlength` cap for how many characters can be typed (null = no attribute). */
  @Input() maxLength: number | null = null;
  @Input() readOnly: boolean = false;
  @Input() disabled: boolean = false;
  @Input() min: string | number | null = null;
  @Input() max: string | number | null = null;
  @Input() ariaInvalid: boolean | null = null;
  /** Id of an external element describing this field (e.g. its error message) for `aria-describedby`. */
  @Input() ariaDescribedBy: string | null = null;
  /** Accessible name for the field when there is no visible `<label for>` (re-audit UX-001). */
  @Input() ariaLabel: string | null = null;
  /** Optional leading icon (a `ri-*` class). Decorative: rendered inside the field, `aria-hidden`. */
  @Input() iconStart: string | null = null;

  private maskSub?: Subscription;

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.control) return;
    if (changes['disabled'] || changes['control']) {
      if (this.disabled && this.control.enabled) {
        this.control.disable({ emitEvent: false });
      } else if (!this.disabled && this.control.disabled) {
        this.control.enable({ emitEvent: false });
      }
    }
    if (changes['control'] || changes['mask'] || changes['stripPattern']) {
      this.setupMask();
    }
  }

  ngOnDestroy(): void {
    this.maskSub?.unsubscribe();
  }

  private setupMask() {
    this.maskSub?.unsubscribe();
    if (!this.control || this.type === 'number') return;
    if (!this.mask && !this.stripPattern) return;

    const strip = this.stripPattern ? new RegExp(this.stripPattern, 'g') : null;
    const apply = (value: unknown) => {
      if (value === null || value === undefined) return;
      let formatted = String(value);
      if (strip) formatted = formatted.replace(strip, '');
      if (this.mask) formatted = this.applyMask(formatted);
      if (formatted !== value) {
        this.control.setValue(formatted, { emitEvent: false });
      }
    };

    apply(this.control.value);
    this.maskSub = this.control.valueChanges.subscribe(value => apply(value));
  }

  private applyMask(value: string): string {
    const digits = value.replace(/\D+/g, '');
    if (!digits) return '';
    let out = '';
    let i = 0;
    for (const ch of this.mask ?? '') {
      if (ch === '#') {
        if (i >= digits.length) break;
        out += digits[i++];
      } else {
        if (i >= digits.length) break;
        out += ch;
      }
    }
    return out;
  }
}
