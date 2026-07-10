/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import type {
  AccessCategoryItem,
  AccessResourceRow,
  UptimeParts,
} from '../../models/settings.models';

@Component({
  selector: 'app-settings-access-panel',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './settings-access-panel.component.html',
  styleUrl: './settings-access-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsAccessPanelComponent {
  @Input({ required: true }) panelId!: string;
  @Input({ required: true }) labelledBy!: string;
  @Input() accessLoadFailed = false;
  @Input() accessLoading = false;
  @Input() accountPermissionsCount = 0;
  @Input() accountResourceCount = 0;
  @Input() sensitiveCount = 0;
  @Input() uptimeParts: UptimeParts | null = null;
  @Input() accessCategories: ReadonlyArray<AccessCategoryItem> = [];
  @Input() accessRows: ReadonlyArray<AccessResourceRow> = [];
}
