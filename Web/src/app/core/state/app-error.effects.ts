/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Actions, createEffect } from '@ngrx/effects';
import { Action } from '@ngrx/store';
import { filter, tap } from 'rxjs/operators';

import { AppErrorService } from '@core/services/app-error.service';

type FailureAction = Action & { error?: unknown };

@Injectable()
export class AppErrorEffects {
  private readonly actions$ = inject(Actions);
  private readonly appError = inject(AppErrorService);

  notifyFailures$ = createEffect(
    () =>
      this.actions$.pipe(
        filter((action): action is FailureAction => action.type.endsWith('Failure')),
        tap(action => {
          // HTTP errors are already surfaced by errorInterceptor (the single owner),
          // so this effect handles only non-HTTP failures — no duplicate toasts/logs.
          if (action.error && !(action.error instanceof HttpErrorResponse)) {
            this.appError.handleError(action.error, { source: 'NgRx', operation: action.type });
          }
        }),
      ),
    { dispatch: false },
  );
}
