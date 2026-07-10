/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiSwitchComponent } from '@shared/components/ui-switch/ui-switch.component';

import type { SettingsNotificationsFormGroup } from '../../models/settings.models';

@Component({
  selector: 'app-settings-notifications-panel',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule, UiButtonComponent, UiSwitchComponent],
  templateUrl: './settings-notifications-panel.component.html',
  styleUrl: './settings-notifications-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsNotificationsPanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input({ required: true }) notificationsForm!: SettingsNotificationsFormGroup;

  @Output() readonly viewAllNotifications = new EventEmitter<void>();
}
