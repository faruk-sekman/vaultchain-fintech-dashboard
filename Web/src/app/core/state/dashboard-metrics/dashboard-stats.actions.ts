/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { createAction, props } from '@ngrx/store';
import { DashboardSummary, KycDistribution } from '@core/api/dashboard.api';

export const loadDashboardStats = createAction('[Dashboard Stats] Load');

export const loadDashboardStatsSuccess = createAction(
  '[Dashboard Stats] Load Success',
  props<{ summary: DashboardSummary; kyc: KycDistribution }>(),
);

export const loadDashboardStatsFailure = createAction(
  '[Dashboard Stats] Load Failure',
  props<{ error: unknown }>(),
);
