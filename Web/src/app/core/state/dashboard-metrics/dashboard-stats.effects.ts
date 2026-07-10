/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, map, switchMap } from 'rxjs/operators';
import { forkJoin, of } from 'rxjs';
import { DashboardApi } from '@core/api/dashboard.api';
import {
  loadDashboardStats,
  loadDashboardStatsFailure,
  loadDashboardStatsSuccess,
} from '@core/state/dashboard-metrics/dashboard-stats.actions';

@Injectable()
export class DashboardStatsEffects {
  private readonly actions$ = inject(Actions);
  private readonly api = inject(DashboardApi);

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadDashboardStats),
      switchMap(() =>
        forkJoin({
          summary: this.api.getSummary(),
          kyc: this.api.getKycDistribution(),
        }).pipe(
          map(({ summary, kyc }) => loadDashboardStatsSuccess({ summary, kyc })),
          catchError(error => of(loadDashboardStatsFailure({ error }))),
        ),
      ),
    ),
  );
}
