/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

/**
 * Binary on/off switch (design-system-ui-kit §5.8). Works in two interchangeable
 * modes:
 *  - reactive: bind a `control` (FormControl<boolean>); or
 *  - stateless: bind `checked` and listen to `(change)`.
 * Rendered as a real `<button role="switch">` with `aria-checked`, so it is
 * keyboard-operable (Space/Enter) and screen-reader correct out of the box.
 */
@Component({
  selector: 'app-ui-switch',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './ui-switch.component.html',
  styleUrl: './ui-switch.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSwitchComponent {
  readonly control = input<FormControl<boolean> | null>(null);
  /** Used only in stateless mode (when no `control` is provided). */
  readonly checked = input(false);
  readonly id = input<string | null>(null);
  readonly label = input<string | null>(null);
  /** Accessible name when there is no visible `label` (e.g. icon-only rows). */
  readonly ariaLabel = input<string | null>(null);
  readonly disabled = input(false);

  readonly change = output<boolean>();

  private readonly destroyRef = inject(DestroyRef);

  /**
   * Reflected value of the bound control, so OnPush repaints when the control's value is pushed
   * from outside (e.g. `setValue`) without a manual `markForCheck()`. Reading it in the `isOn`
   * computed registers the dependency; the `valueChanges` subscription keeps it in sync. The
   * FormControl's value is not itself a signal, so this is the bridge.
   */
  private readonly controlValue = signal<boolean>(false);
  /**
   * Reflected disabled state of the bound control as a signal, so `isDisabled` recomputes when the
   * parent calls `control.disable()` at runtime (the control's status is not itself a signal). Kept
   * in sync by the `statusChanges` subscription alongside `controlValue`.
   */
  private readonly controlDisabled = signal<boolean>(false);
  /** Stateless-mode value, seeded from the `checked` input and toggled internally. */
  private readonly statelessValue = signal<boolean>(false);
  private statusSub?: Subscription;

  readonly isOn = computed(() => (this.control() ? this.controlValue() : this.statelessValue()));

  readonly isDisabled = computed(
    () => this.disabled() || (!!this.control() && this.controlDisabled()),
  );

  readonly labelId = computed(() => {
    const id = this.id();
    return this.label() && id ? `${id}-label` : null;
  });

  constructor() {
    // Keep the stateless value in step with the `checked` input (one-way binding mode).
    effect(() => this.statelessValue.set(this.checked()));

    // Re-subscribe to the bound control whenever it changes; reflect external value/status pushes
    // through signals so OnPush repaints without a manual change-detection tick.
    effect(() => {
      const control = this.control();
      this.statusSub?.unsubscribe();
      if (control) {
        this.controlValue.set(!!control.value);
        this.controlDisabled.set(control.disabled);
        const valueSub = control.valueChanges
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(value => this.controlValue.set(!!value));
        const statusSub = control.statusChanges
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => this.controlDisabled.set(control.disabled));
        valueSub.add(statusSub);
        this.statusSub = valueSub;
      }
    });

    // Sync the `disabled` input down to the bound control (enable/disable without emitting).
    effect(() => {
      const control = this.control();
      const disabled = this.disabled();
      if (!control) return;
      if (disabled && control.enabled) {
        control.disable({ emitEvent: false });
      } else if (!disabled && control.disabled) {
        control.enable({ emitEvent: false });
      }
    });

    this.destroyRef.onDestroy(() => this.statusSub?.unsubscribe());
  }

  toggle(): void {
    if (this.isDisabled()) return;
    const next = !this.isOn();

    const control = this.control();
    if (control) {
      control.setValue(next);
      control.markAsDirty();
      control.markAsTouched();
    } else {
      // Stateless: the originating (click) event already marks this OnPush view for check.
      this.statelessValue.set(next);
    }

    this.change.emit(next);
  }
}
