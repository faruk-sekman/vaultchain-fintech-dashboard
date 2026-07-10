/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import {
  UiSegmentedComponent,
  UiSegmentItem,
} from '@shared/components/ui-segmented/ui-segmented.component';

import type { AppLang } from '../../models/settings.models';

@Component({
  selector: 'app-settings-language-panel',
  standalone: true,
  imports: [TranslateModule, UiSegmentedComponent],
  templateUrl: './settings-language-panel.component.html',
  styleUrl: './settings-language-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsLanguagePanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input({ required: true }) currentLang!: AppLang;
  @Input() langOptions: ReadonlyArray<UiSegmentItem> = [];

  @Output() readonly langChange = new EventEmitter<string>();
}
