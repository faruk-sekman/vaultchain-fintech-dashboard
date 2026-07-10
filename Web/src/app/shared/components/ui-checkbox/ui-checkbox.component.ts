/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

type CheckboxNgClass = string | string[] | Set<string> | { [csClass: string]: unknown };

@Component({
  selector: 'app-ui-checkbox',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './ui-checkbox.component.html',
  styleUrl: './ui-checkbox.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCheckboxComponent {
  readonly control = input.required<FormControl>();
  readonly id = input<string | null>(null);
  readonly inputClass = input<CheckboxNgClass | null>(null);
  readonly label = input<string | null>(null);
  readonly readOnly = input(false);
  readonly disabled = input(false);
}
