/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';

import type { SettingsProfileFormGroup } from '../../models/settings.models';

@Component({
  selector: 'app-settings-profile-panel',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, UiButtonComponent, UiInputComponent],
  templateUrl: './settings-profile-panel.component.html',
  styleUrl: './settings-profile-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsProfilePanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input({ required: true }) profileForm!: SettingsProfileFormGroup;
  @Input() profileSaving = false;

  @Output() readonly cancelProfile = new EventEmitter<void>();
  @Output() readonly saveProfile = new EventEmitter<void>();
}
