/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import type { RememberedDevice } from '@core/api/mfa.api';
import { UiAlertComponent } from '@shared/components/ui-alert/ui-alert.component';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiConfirmDialogComponent } from '@shared/components/ui-confirm-dialog/ui-confirm-dialog.component';
import { UiInputComponent } from '@shared/components/ui-input/ui-input.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { HasPermissionDirective } from '@shared/directives/has-permission.directive';

import type { SettingsMfaReauthFormGroup } from '../../models/settings.models';

export type SettingsMfaAction = 'disable' | 'regenerate';

@Component({
  selector: 'app-settings-security-panel',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    TranslateModule,
    UiAlertComponent,
    UiBadgeComponent,
    UiButtonComponent,
    UiConfirmDialogComponent,
    UiInputComponent,
    UiSkeletonComponent,
    HasPermissionDirective,
  ],
  templateUrl: './settings-security-panel.component.html',
  styleUrl: './settings-security-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsSecurityPanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input({ required: true }) locale!: string;
  @Input({ required: true }) mfaReauthForm!: SettingsMfaReauthFormGroup;
  @Input() mfaEnabled = false;
  @Input() mfaAction: SettingsMfaAction | null = null;
  @Input() mfaSubmitting = false;
  @Input() mfaErrorKey: string | null = null;
  @Input() mfaNewBackupCodes: readonly string[] = [];
  @Input() mfaCodesSaved = false;
  @Input() devices: readonly RememberedDevice[] = [];
  @Input() devicesLoading = false;
  @Input() devicesErrorKey: string | null = null;
  @Input() revokingId: string | null = null;
  @Input() confirmRevokeId: string | null = null;
  @Input() skeletonRows: readonly number[] = [];

  @Output() readonly enableMfa = new EventEmitter<void>();
  @Output() readonly openMfaAction = new EventEmitter<SettingsMfaAction>();
  @Output() readonly toggleMfaCodesSaved = new EventEmitter<void>();
  @Output() readonly dismissNewBackupCodes = new EventEmitter<void>();
  @Output() readonly cancelMfaAction = new EventEmitter<void>();
  @Output() readonly submitMfaAction = new EventEmitter<void>();
  @Output() readonly retryLoadDevices = new EventEmitter<void>();
  @Output() readonly askRevoke = new EventEmitter<string>();
  @Output() readonly confirmRevoke = new EventEmitter<void>();
  @Output() readonly cancelRevoke = new EventEmitter<void>();
  @Output() readonly openAdminMfaReset = new EventEmitter<void>();
  @Output() readonly openAdminPasswordReset = new EventEmitter<void>();
}
