/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { UiBadgeComponent, UiBadgeColor } from '@shared/components/ui-badge/ui-badge.component';
import { KycStatus } from '@shared/models/customer.model';
import { getKycStatusBadgeColor, kycLabelKey } from '@shared/utils/kyc-status';

@Component({
  selector: 'app-customer-status-badge',
  standalone: true,
  imports: [CommonModule, UiBadgeComponent, TranslateModule],
  templateUrl: './customer-status-badge.component.html',
  styleUrl: './customer-status-badge.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerStatusBadgeComponent {
  @Input() status: KycStatus | string = 'NOT_STARTED';

  get color(): UiBadgeColor {
    return getKycStatusBadgeColor(this.status);
  }

  /** i18n key for the KYC status (shared `kyc.*` namespace). */
  get labelKey(): string {
    return kycLabelKey(this.status);
  }
}
