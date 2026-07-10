/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Actions } from '@ngrx/effects';
import { Subject } from 'rxjs';
import { AppErrorEffects } from '@core/state/app-error.effects';
import { AppErrorService } from '@core/services/app-error.service';

describe('AppErrorEffects', () => {
  it('notifies on *Failure actions with error', () => {
    const actions$ = new Subject<any>();
    const appError = { handleError: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: AppErrorService, useValue: appError },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new AppErrorEffects());
    const sub = effects.notifyFailures$.subscribe();

    const error = new Error('fail');
    actions$.next({ type: '[Any] Failure', error });

    expect(appError.handleError).toHaveBeenCalledWith(error, {
      source: 'NgRx',
      operation: '[Any] Failure',
    });

    sub.unsubscribe();
  });

  it('skips HTTP failures (owned by errorInterceptor)', () => {
    const actions$ = new Subject<any>();
    const appError = { handleError: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: AppErrorService, useValue: appError },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new AppErrorEffects());
    const sub = effects.notifyFailures$.subscribe();

    actions$.next({ type: '[Any] Failure', error: new HttpErrorResponse({ status: 500 }) });
    expect(appError.handleError).not.toHaveBeenCalled();

    sub.unsubscribe();
  });

  it('ignores non-failure actions', () => {
    const actions$ = new Subject<any>();
    const appError = { handleError: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: AppErrorService, useValue: appError },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new AppErrorEffects());
    const sub = effects.notifyFailures$.subscribe();

    actions$.next({ type: '[Any] Success' });

    expect(appError.handleError).not.toHaveBeenCalled();

    sub.unsubscribe();
  });

  it('ignores failure actions without error payload', () => {
    const actions$ = new Subject<any>();
    const appError = { handleError: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: Actions, useValue: new Actions(actions$) },
        { provide: AppErrorService, useValue: appError },
      ],
    });

    const effects = TestBed.runInInjectionContext(() => new AppErrorEffects());
    const sub = effects.notifyFailures$.subscribe();

    actions$.next({ type: '[Any] Failure' });
    expect(appError.handleError).not.toHaveBeenCalled();

    sub.unsubscribe();
  });
});
