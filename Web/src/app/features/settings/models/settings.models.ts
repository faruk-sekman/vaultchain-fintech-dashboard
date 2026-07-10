/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import type { FormControl, FormGroup } from '@angular/forms';

import type { ThemeMode } from '@core/services/theme.service';

/** Settings sections that drive the underline tabs and active panel. */
export type SettingsSection =
  | 'profile'
  | 'security'
  | 'appearance'
  | 'language'
  | 'notifications'
  | 'access';

/** Appearance theme choice. `system` follows `prefers-color-scheme` at apply time. */
export type ThemeChoice = ThemeMode | 'system';

/** Supported UI languages. */
export type AppLang = 'en' | 'tr';

export const LANG_STORAGE_KEY = 'lang';

/** Access-panel category model: permission resources map to operator-meaningful domains. */
export type AccessCategory = 'identity' | 'customer' | 'kyc' | 'financial';

/** Aside-legend metadata for one access category. */
export interface AccessCategoryItem {
  key: AccessCategory;
  labelKey: string;
}

/** One granted scope chip in the access table. */
export interface AccessScope {
  code: string;
  action: string;
  sensitive: boolean;
}

/** One access-table row: a resource with its granted scopes, tagged with its legend category. */
export interface AccessResourceRow {
  resource: string;
  category: AccessCategory;
  scopes: AccessScope[];
}

/** Current account permissions grouped by resource domain. */
export interface AccessPermissionGroup {
  resource: string;
  items: readonly string[];
}

/** API uptime split for localized display. */
export interface UptimeParts {
  hours: number;
  minutes: number;
}

export type SettingsProfileFormGroup = FormGroup<{
  displayName: FormControl<string>;
  email: FormControl<string>;
  phone: FormControl<string>;
  jobTitle: FormControl<string>;
}>;

export type SettingsNotificationsFormGroup = FormGroup<{
  productUpdates: FormControl<boolean>;
  securityAlerts: FormControl<boolean>;
  weeklyDigest: FormControl<boolean>;
}>;

export type SettingsMfaReauthFormGroup = FormGroup<{
  password: FormControl<string>;
  code: FormControl<string>;
}>;
