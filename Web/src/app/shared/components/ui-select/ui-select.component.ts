/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SelectOption } from '@shared/components/ui-form/ui-form.types';

@Component({
  selector: 'app-ui-select',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TranslateModule],
  templateUrl: './ui-select.component.html',
  styleUrl: './ui-select.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSelectComponent {
  @Input({ required: true }) control!: FormControl;
  @Input() id: string | null = null;
  @Input() options: ReadonlyArray<SelectOption> = [];
  @Input() ariaInvalid: boolean | null = null;
  /** Id of an external element describing this field (e.g. its error message) for `aria-describedby`. */
  @Input() ariaDescribedBy: string | null = null;
  @Input() inputClass: string | string[] | Set<string> | { [csClass: string]: any } | null = null;
  @Input() readOnly: boolean = false;
  @Input() disabled: boolean = false;
}
