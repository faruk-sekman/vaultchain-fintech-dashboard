/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import { DensityMode } from '@core/services/density.service';
import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';

import type { ThemeChoice } from '../../models/settings.models';

@Component({
  selector: 'app-settings-appearance-panel',
  standalone: true,
  imports: [TranslateModule, UiSegmentedComponent],
  templateUrl: './settings-appearance-panel.component.html',
  styleUrl: './settings-appearance-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsAppearancePanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input({ required: true }) themeChoice!: ThemeChoice;
  @Input({ required: true }) density!: DensityMode;
  @Input() themeOptions: ReadonlyArray<UiSegmentItem> = [];
  @Input() densityOptions: ReadonlyArray<UiSegmentItem> = [];

  @Output() readonly themeChange = new EventEmitter<string>();
  @Output() readonly densityChange = new EventEmitter<string>();
}
